import { defineConfig } from "tsup";

// Single-file, dependency-free CLI bundle with a shebang so the built
// `dist/cli.js` is directly executable and requires nothing but Node >=20.
export default defineConfig({
  entry: { cli: "src/cli.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  // node:sqlite is a newer builtin esbuild doesn't know yet; keep it external so it isn't resolved
  // as an npm package.
  external: ["node:sqlite"],
  clean: true,
  minify: false,
  sourcemap: false,
  banner: { js: "#!/usr/bin/env node" },
});
