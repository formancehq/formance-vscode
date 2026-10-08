import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["out/", ".vscode-test/", "node_modules/"] },
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      curly: "warn",
      eqeqeq: "warn",
      "no-throw-literal": "warn",
    },
  },
);
