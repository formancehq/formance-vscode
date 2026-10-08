// Bundles the extension and its runtime dependencies into dist/extension.js.
// Usage: node esbuild.mjs [--production] [--watch]
import * as esbuild from "esbuild";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

const ctx = await esbuild.context({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node20",
  external: ["vscode"],
  minify: production,
  sourcemap: !production,
  sourcesContent: false,
  logLevel: "info",
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
