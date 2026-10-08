import os from "node:os";
import path from "node:path";
import { defineConfig } from "@vscode/test-cli";

const base = {
  files: "out/test/**/*.test.js",
  mocha: { ui: "tdd", timeout: 20000 },
  env: { NUMSCRIPT_START_TIMEOUT_MS: "2000" },
};

// VS Code's IPC socket lives in the user data dir and its path must stay
// under 103 characters, which a deep checkout can exceed.
const userDataDir = (label) => [
  "--user-data-dir",
  path.join(os.tmpdir(), `formance-vscode-test-${label}`),
];

export default defineConfig([
  { ...base, label: "stable", launchArgs: userDataDir("stable") },
  // Keep in sync with engines.vscode in package.json.
  {
    ...base,
    label: "minimum",
    version: "1.94.0",
    launchArgs: userDataDir("minimum"),
  },
]);
