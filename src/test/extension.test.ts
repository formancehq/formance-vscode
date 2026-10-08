import * as assert from "node:assert";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setServerPath(value: string): Thenable<void> {
  return vscode.workspace
    .getConfiguration("numscript")
    .update("server-path", value, vscode.ConfigurationTarget.Global);
}

// Pids of running processes whose command line contains needle.
function processesMatching(needle: string): string[] {
  return execFileSync("ps", ["-ax", "-o", "pid=,command="])
    .toString()
    .split("\n")
    .filter((line) => line.includes(needle))
    .map((line) => line.trim().split(/\s+/)[0]);
}

async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    if (condition()) {
      return true;
    }
    await sleep(100);
  }
  return condition();
}

suite("extension", () => {
  test("registers the numscript language", async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes("numscript"));
  });

  test("activates from the bundle and registers its commands", async () => {
    // A configured path disables the GitHub download so the test stays offline.
    await setServerPath("/nonexistent/numscript");

    const ext = vscode.extensions.getExtension("formance.formance-vscode");
    assert.ok(ext, "extension not found");
    await ext.activate();
    assert.ok(ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("numscript.restartServer"));
    assert.ok(commands.includes("numscript.updateServer"));
  });

  test("terminates a server that never answers initialize", async function () {
    if (process.platform === "win32") {
      this.skip();
    }
    // .vscode-test.mjs lowers the start timeout to 2 seconds.
    this.timeout(20_000);
    await vscode.extensions
      .getExtension("formance.formance-vscode")!
      .activate();

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "numscript-hung-"));
    const hungServer = path.join(dir, "hung-server");
    await fs.writeFile(hungServer, "#!/usr/bin/env perl\nsleep 1000;\n");
    await fs.chmod(hungServer, 0o755);
    try {
      // Changing the setting restarts the server with the new path.
      await setServerPath(hungServer);
      assert.ok(
        await waitFor(() => processesMatching(hungServer).length > 0, 5_000),
        "the server was not started",
      );
      assert.ok(
        await waitFor(() => processesMatching(hungServer).length === 0, 8_000),
        "the server is still running after the start timeout",
      );
    } finally {
      await setServerPath("/nonexistent/numscript");
      for (const pid of processesMatching(hungServer)) {
        process.kill(Number(pid), "SIGKILL");
      }
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
