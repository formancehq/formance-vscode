import * as assert from "node:assert";
import * as vscode from "vscode";

suite("extension", () => {
  test("registers the numscript language", async () => {
    const languages = await vscode.languages.getLanguages();
    assert.ok(languages.includes("numscript"));
  });

  test("activates from the bundle and registers its commands", async () => {
    // A configured path disables the GitHub download so the test stays offline.
    await vscode.workspace
      .getConfiguration("numscript")
      .update(
        "server-path",
        "/nonexistent/numscript",
        vscode.ConfigurationTarget.Global,
      );

    const ext = vscode.extensions.getExtension("formance.formance-vscode");
    assert.ok(ext, "extension not found");
    await ext.activate();
    assert.ok(ext.isActive);

    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("numscript.restartServer"));
    assert.ok(commands.includes("numscript.updateServer"));
  });
});
