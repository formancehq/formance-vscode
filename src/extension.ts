// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from "vscode";
import {
  Executable,
  LanguageClient,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";

const RESTART_SERVER_COMMAND = "numscript.restartServer";

const executable: Executable = {
  command: "numscript",
  args: ["lsp"],
  transport: TransportKind.stdio,
};

const serverOptions: ServerOptions = {
  run: executable,
  debug: executable,
};

const clientOptions = {
  documentSelector: [
    {
      scheme: "file",
      language: "numscript",
    },
  ],
};

const client = new LanguageClient(
  "numscript-ls",
  "Numscript language client",
  serverOptions,
  clientOptions
);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(
    'Congratulations, your extension "numscript-prototype-vscode" is now active!'
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
    }
  );

  // The command has been defined in the package.json file
  // Now provide the implementation of the command with registerCommand
  // The commandId parameter must match the command field in package.json
  const disposable = vscode.commands.registerCommand(
    "numscript.helloWorld",
    () => {
      // The code you place here will be executed every time your command is executed
      // Display a message box to the user
      vscode.window.showInformationMessage(
        "Hello World from numscript-prototype-vscode!"
      );
    }
  );

  client.start().catch((e) => {
    console.error(e);
  });

  context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
