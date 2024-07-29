// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import path from "node:path";
import * as vscode from "vscode";
import {
  Executable,
  LanguageClient,
  ServerOptions,
} from "vscode-languageclient/node";
import fs from "node:fs";
import tar from "tar-fs";
import { pipeline } from "stream";
import util from "node:util";
import zlib from "node:zlib";
const fetch = require("node-fetch");

const NUMSCRIPT_REPO = "formancehq/numscript";
const NUMSCRIPT_EXECUTABLE_NAME = "numscript";
const SERVER_TIMESTAMP = "serverTimestamp";

const RESTART_SERVER_COMMAND = "numscript.restartServer";

const clientOptions = {
  documentSelector: [
    {
      scheme: "file",
      language: "numscript",
    },
  ],
};

export interface GithubAsset {
  name: string;
  browser_download_url: vscode.Uri;
}

export interface GithubRelease {
  name: string;
  id: number;
  published_at: string;
  assets: Array<GithubAsset>;
}

export async function fetchReleaseInfo(): Promise<GithubRelease> {
  const response = await fetch(
    `https://api.github.com/repos/${NUMSCRIPT_REPO}/releases/latest`,
    {
      headers: { Accept: "application/vnd.github.v3+json" },
    },
  );
  if (!response.ok) {
    throw new Error(
      `Got response ${response.status} when trying to fetch latest release`,
    );
  }

  return (await response.json()) as any;
}

const ARCHS: Record<string, string> = {
  x64: "x86_64",
  arm64: "arm64",
};

const PLATFORMS: Record<string, string> = {
  win64: "Windows",
  windows: "Windows",
  linux: "Linux",
  darwin: "Darwin",
};

function getPlatformBinary(
  arch = process.arch,
  platform = process.platform,
): string | undefined {
  const archLookup = ARCHS[arch];
  if (archLookup === undefined) {
    return undefined;
  }

  const platformLookup = PLATFORMS[platform];
  if (platformLookup === undefined) {
    return undefined;
  }

  return `${platformLookup}_${archLookup}`;
}

async function downloadServer(
  assets: Array<GithubAsset>,
  ctx: vscode.ExtensionContext,
): Promise<string> {
  const platform = getPlatformBinary();
  if (platform === undefined) {
    vscode.window.showErrorMessage(
      `Your platform (${process.platform} - ${process.arch}) does not have prebuilt language server binaries yet, ` +
        "you'll have to clone numary/numscript-ls and build the server yourself, " +
        "then set the server path in the Numscript Extension's settings.",
    );
    throw new Error("no available binaries");
  }

  const asset = assets.find((a) => a.name.toString().includes(platform));

  if (asset === undefined) {
    throw new Error(
      `Asset '${platform}' not found (given " + ${JSON.stringify(
        assets.map((a) => a.name),
      )})`,
    );
  }

  vscode.workspace.fs.createDirectory(ctx.globalStorageUri);
  const globalStorage = path.parse(ctx.globalStorageUri.fsPath);
  const res = await fetch(asset.browser_download_url.toString());
  if (!res.ok) {
    throw new Error(`couldn't download file: got status code ${res.status}`);
  }

  const totalBytes = Number(res.headers.get("content-length"));
  console.log(`Downloading server: ${totalBytes} bytes`);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      cancellable: false,
      title: "Downloading...",
    },
    async (progress, _cancellationToken) => {
      let readBytes = 0;
      if (res === null || res.body === null) {
        return;
      }
      res.body.on("data", (chunk: Buffer) => {
        readBytes += chunk.length;
        const percentage = Math.round(readBytes / totalBytes) * 100;
        progress.report({
          message: `${percentage}%`,
          increment: chunk.length / totalBytes,
        });
        console.log(`${readBytes} / ${totalBytes}`);
      });

      await util.promisify(pipeline)(
        res.body!,
        zlib.createGunzip(),
        tar.extract(path.join(globalStorage.dir, globalStorage.base)),
      );
    },
  );

  return path.join(globalStorage.dir, globalStorage.base, "numscript");
}

async function resolveServerPath(
  ctx: vscode.ExtensionContext,
): Promise<string | undefined> {
  const serverPath = vscode.workspace
    .getConfiguration("numscript")
    .get("server-path")!;

  if (serverPath !== null && serverPath !== "") {
    console.log("found exec path:", serverPath);

    return serverPath as string;
  }

  const releaseInfo = await fetchReleaseInfo();

  const currentServerTimestamp = ctx.globalState.get(SERVER_TIMESTAMP);
  console.log(
    `stored timestamp: ${currentServerTimestamp}\nlatest timestamp: ${releaseInfo.published_at}`,
  );

  if (currentServerTimestamp === releaseInfo.published_at) {
    const serverPath = path.join(
      ctx.globalStorageUri.fsPath,
      NUMSCRIPT_EXECUTABLE_NAME,
    );

    const alreadyExists = fs.existsSync(serverPath);

    if (alreadyExists) {
      return serverPath;
    }
  }

  const selection = await vscode.window.showInformationMessage(
    "Do you want to download the language server ?",
    "Yes",
    "No",
  );
  if (selection !== "Yes") {
    return undefined;
  }

  const downloadedServerPath = await downloadServer(releaseInfo.assets, ctx);
  console.log({ downloadedServerPath });

  ctx.globalState.update(SERVER_TIMESTAMP, releaseInfo.published_at);
  vscode.window.showInformationMessage(
    "Numscript language server downladed succesfully",
  );
  return downloadedServerPath;
}

export async function activate(context: vscode.ExtensionContext) {
  const releaseInfo = await resolveServerPath(context);
  console.log({ releaseInfo });
  if (releaseInfo === undefined) {
    return;
  }

  const executable: Executable = {
    command: releaseInfo,
    args: ["lsp"],
  };

  const serverOptions: ServerOptions = {
    run: executable,
    debug: executable,
  };

  const client = new LanguageClient(
    "formance-vscode",
    "Numscript language client",
    serverOptions,
    clientOptions,
  );

  // Copied from:
  // https://github.com/gleam-lang/vscode-gleam/blob/1a8cac7103f85e3e4e309190bb4d43ac1483cef9/src/extension.ts#L23
  const restartCommand = vscode.commands.registerCommand(
    RESTART_SERVER_COMMAND,
    async () => {
      if (!client) {
        vscode.window.showErrorMessage("numscript client not found");
        return;
      }

      try {
        if (client.isRunning()) {
          await client.restart();

          vscode.window.showInformationMessage("numscript server restarted.");
        } else {
          await client.start();
        }
      } catch (err) {
        client.error("Restarting client failed", err, "force");
      }
    },
  );

  client.start().catch((e) => {
    console.error(e);
  });

  context.subscriptions.push(restartCommand);
}

// This method is called when your extension is deactivated
export function deactivate() {}
