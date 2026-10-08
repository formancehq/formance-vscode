import { ChildProcess, spawn } from "node:child_process";
import * as vscode from "vscode";
import { CloseAction, LanguageClient, State } from "vscode-languageclient/node";
import * as server from "./server";

const SERVER_VERSION_KEY = "serverVersion";
// Key used by versions before 0.1.0, which tracked the release date.
const LEGACY_SERVER_TIMESTAMP_KEY = "serverTimestamp";
// How long the server may take to answer the LSP initialize request.
const START_TIMEOUT_MS = 30_000;
// How long a stop waits for a client that is still starting.
const STOP_WAIT_MS = 5_000;
// How long a stopped server may take to exit before it is killed.
const PROCESS_EXIT_GRACE_MS = 2_000;

let client: LanguageClient | undefined;
let log: vscode.LogOutputChannel;
// The server process of each client. The client does not expose it, and only
// cleans up processes it spawns itself.
const serverProcesses = new WeakMap<LanguageClient, ChildProcess>();
// Clients that were stopped or abandoned and must not restart.
const retiredClients = new WeakSet<LanguageClient>();

// Every operation that starts, stops or replaces the server runs through this
// queue so that two of them never interleave, e.g. a restart during an update.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(operation: () => Promise<T>): Promise<T> {
  const result = queue.then(operation);
  queue = result.catch(() => undefined);
  return result;
}

interface Options {
  // True when the user explicitly asked for the operation: no confirmation
  // prompt, and failures or "already up to date" are reported.
  interactive: boolean;
}

function configuredServerPath(): string | undefined {
  const value = vscode.workspace
    .getConfiguration("numscript")
    .get<string>("server-path");
  return value ? value : undefined;
}

function storageDir(ctx: vscode.ExtensionContext): string {
  return ctx.globalStorageUri.fsPath;
}

async function resolveServerPath(
  ctx: vscode.ExtensionContext,
): Promise<string | undefined> {
  const configured = configuredServerPath();
  if (configured !== undefined) {
    return configured;
  }

  const tag = ctx.globalState.get<string>(SERVER_VERSION_KEY);
  if (tag !== undefined && (await server.isInstalled(storageDir(ctx), tag))) {
    return server.installedExecutable(storageDir(ctx), tag);
  }
  // Keeps users upgrading from 0.0.x working until the first download.
  const legacy = server.legacyExecutable(storageDir(ctx));
  if (await server.fileExists(legacy)) {
    return legacy;
  }
  return undefined;
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Must run in the queue. Starts the given executable, or the configured or
// installed one.
async function startClient(
  ctx: vscode.ExtensionContext,
  executablePath?: string,
): Promise<boolean> {
  const command = executablePath ?? (await resolveServerPath(ctx));
  if (command === undefined) {
    return false;
  }

  log.info(`Starting language server: ${command}`);
  const candidate: LanguageClient = new LanguageClient(
    "numscript",
    "Numscript language server",
    // Spawned here, rather than by the client, so that a server that never
    // finishes starting can still be terminated.
    async () => {
      const serverProcess = spawn(command, ["lsp"]);
      serverProcess.on("error", (err) =>
        log.error(`Could not run ${command}`, err),
      );
      serverProcesses.set(candidate, serverProcess);
      return serverProcess;
    },
    {
      documentSelector: [{ scheme: "file", language: "numscript" }],
      // Shared with the extension logs, and not disposed by the client, so
      // failed starts do not leave extra output channels behind.
      outputChannel: log,
      // The client restarts a server whose connection closes. Killing a
      // retired client's server must not restart it behind our back.
      errorHandler: {
        error: (error, message, count) =>
          defaultErrorHandler.error(error, message, count),
        closed: () =>
          retiredClients.has(candidate)
            ? { action: CloseAction.DoNotRestart, handled: true }
            : defaultErrorHandler.closed(),
      },
    },
  );
  const defaultErrorHandler = candidate.createDefaultErrorHandler();

  // Tracked before it starts so that a later stop can still reach a server
  // that answers late.
  client = candidate;
  try {
    // The client reports start failures to the user itself.
    await withTimeout(
      candidate.start(),
      START_TIMEOUT_MS,
      `${command} did not answer the LSP initialize request`,
    );
    return true;
  } catch (err) {
    log.error(`Language server failed to start: ${command}`, err);
    if (candidate.state === State.Starting) {
      vscode.window.showErrorMessage(
        `Numscript language server ${command} did not respond. See the Numscript output for details.`,
      );
    }
    return false;
  }
}

// Must run in the queue.
async function stopClient(): Promise<void> {
  const current = client;
  client = undefined;
  if (current === undefined) {
    return;
  }
  retiredClients.add(current);
  if (current.state === State.Starting) {
    // Still starting, or restarting itself after a crash: start() returns
    // the pending start, which must settle before the client can be stopped.
    await withTimeout(current.start(), STOP_WAIT_MS, "start pending").catch(
      () => undefined,
    );
  }
  const serverProcess = serverProcesses.get(current);
  if (current.isRunning()) {
    try {
      await current.stop();
    } catch (err) {
      log.warn("Language server did not stop cleanly", err);
    }
    // Like the client does for processes it spawns: give the server time to
    // exit after the shutdown request, then force it.
    setTimeout(() => killServer(serverProcess), PROCESS_EXIT_GRACE_MS);
  } else {
    if (current.state === State.Starting) {
      log.warn("Terminating a language server that never finished starting");
    }
    killServer(serverProcess);
  }
}

// SIGKILL, as the extension host may ignore SIGTERM, which children inherit.
function killServer(serverProcess: ChildProcess | undefined): void {
  if (
    serverProcess !== undefined &&
    serverProcess.exitCode === null &&
    serverProcess.signalCode === null
  ) {
    serverProcess.kill("SIGKILL");
  }
}

async function restartServer(
  ctx: vscode.ExtensionContext,
  options: Options,
): Promise<void> {
  const started = await serialized(async () => {
    await stopClient();
    return startClient(ctx);
  });
  if (started) {
    if (options.interactive) {
      vscode.window.showInformationMessage(
        "Numscript language server restarted.",
      );
    }
    return;
  }
  if (configuredServerPath() === undefined) {
    await checkForUpdate(ctx, options);
  }
}

// Not serialized: an unanswered prompt must not block other operations.
async function checkForUpdate(
  ctx: vscode.ExtensionContext,
  { interactive }: Options,
): Promise<void> {
  if (configuredServerPath() !== undefined) {
    if (interactive) {
      vscode.window.showInformationMessage(
        "numscript.server-path is set, so the language server is not downloaded. Clear the setting to use the latest release.",
      );
    }
    return;
  }

  let release: server.GithubRelease;
  try {
    release = await server.fetchLatestRelease();
  } catch (err) {
    log.warn("Could not check for language server updates", err);
    if (interactive) {
      vscode.window.showErrorMessage(
        `Could not check for Numscript language server updates: ${errorMessage(err)}`,
      );
    }
    return;
  }

  const installed = ctx.globalState.get<string>(SERVER_VERSION_KEY);
  log.info(
    `Installed server: ${installed ?? "none"}, latest: ${release.tag_name}`,
  );
  if (
    installed === release.tag_name &&
    (await server.isInstalled(storageDir(ctx), installed))
  ) {
    if (interactive) {
      vscode.window.showInformationMessage(
        `Numscript language server ${installed} is up to date.`,
      );
    }
    return;
  }

  if (!interactive) {
    const action = installed === undefined ? "Download" : "Update";
    const message =
      installed === undefined
        ? `Download the Numscript language server (${release.tag_name}) for diagnostics, hover and go to definition?`
        : `Numscript language server ${release.tag_name} is available (installed: ${installed}).`;
    if (
      (await vscode.window.showInformationMessage(message, action)) !== action
    ) {
      return;
    }
  }

  await serialized(() => installServer(ctx, release));
}

// Must run in the queue.
async function installServer(
  ctx: vscode.ExtensionContext,
  release: server.GithubRelease,
): Promise<void> {
  const tag = release.tag_name;
  // A concurrent check, or another window sharing the global storage, may
  // have installed this release while the prompt was open.
  if (ctx.globalState.get(SERVER_VERSION_KEY) === tag && client?.isRunning()) {
    return;
  }

  if (!(await server.isInstalled(storageDir(ctx), tag))) {
    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading Numscript language server ${tag}`,
        },
        async (progress) => {
          let reported = 0;
          await server.installRelease(
            release,
            storageDir(ctx),
            (received, total) => {
              if (total === undefined) {
                return;
              }
              const percent = Math.floor((received / total) * 100);
              if (percent > reported) {
                progress.report({
                  message: `${percent}%`,
                  increment: percent - reported,
                });
                reported = percent;
              }
            },
          );
        },
      );
    } catch (err) {
      log.error("Language server download failed", err);
      vscode.window.showErrorMessage(
        `Numscript language server download failed: ${errorMessage(err)}`,
      );
      return;
    }
  }

  // Switch only once the new version has started, so that a release that
  // does not run on this machine leaves the previous version in place.
  await stopClient();
  if (
    !(await startClient(ctx, server.installedExecutable(storageDir(ctx), tag)))
  ) {
    vscode.window.showErrorMessage(
      `Numscript language server ${tag} failed to start; keeping the previous version.`,
    );
    await stopClient();
    await startClient(ctx);
    return;
  }

  await ctx.globalState.update(SERVER_VERSION_KEY, tag);
  await ctx.globalState.update(LEGACY_SERVER_TIMESTAMP_KEY, undefined);
  await server.pruneOtherVersions(storageDir(ctx), tag);
  vscode.window.showInformationMessage(
    `Numscript language server ${tag} installed.`,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logFailure(err: unknown): void {
  log.error("Unexpected error", err);
}

export async function activate(ctx: vscode.ExtensionContext): Promise<void> {
  log = vscode.window.createOutputChannel("Numscript", { log: true });
  ctx.subscriptions.push(
    log,
    vscode.commands.registerCommand("numscript.restartServer", () =>
      restartServer(ctx, { interactive: true }),
    ),
    vscode.commands.registerCommand("numscript.updateServer", () =>
      checkForUpdate(ctx, { interactive: true }),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("numscript.server-path")) {
        restartServer(ctx, { interactive: false }).catch(logFailure);
      }
    }),
  );

  await serialized(() => startClient(ctx));
  // Check for updates in the background so activation is not blocked on the
  // network or on the user answering the prompt.
  checkForUpdate(ctx, { interactive: false }).catch(logFailure);
}

export function deactivate(): Promise<void> {
  return serialized(stopClient);
}
