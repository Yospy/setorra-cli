import { defineConfig } from "tsup";

// `yaml` and `zod` are devDependencies on purpose: they are bundled into the output, so
// `npx setorra` installs one file rather than resolving a dependency tree at run time.
export default defineConfig({
  entry: { setorra: "src/bin.ts" },
  outDir: "dist",
  format: ["esm"],
  platform: "node",
  target: "node20",
  clean: true,
  splitting: false,
  sourcemap: false,
  treeshake: true,
  // `yaml` publishes a CommonJS build for the node condition, so bundling it into an ESM
  // output leaves esbuild's `__require` shim in the graph -- and that shim throws on the
  // first `require("process")`. Defining a real `require` gives it something to call.
  // Without this the bundle fails at import time, before any of our code runs.
  banner: {
    js: [
      "import { createRequire as __setorraCreateRequire } from \"node:module\";",
      "const require = __setorraCreateRequire(import.meta.url);",
    ].join("\n"),
  },
});
