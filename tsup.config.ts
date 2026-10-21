import { defineConfig } from "tsup";

export default defineConfig({
  // P1-EMBED-WORKER — second entry so tsup follows the worker into the build
  // graph and emits dist/cli/embed-worker.js (the worker is loaded at runtime
  // via new Worker(), so it is NOT in the main bundle's static import graph).
  // OBJECT form (output-name → source) keeps BOTH files flat under outDir as
  // dist/cli/index.js + dist/cli/embed-worker.js. The array form would mirror
  // the source dirs (dist/cli/cli/index.js + dist/cli/manager/embed-worker.js),
  // breaking both the deploy's DIST_FILE and the worker path resolver.
  entry: {
    index: "src/cli/index.ts",
    "embed-worker": "src/manager/embed-worker.ts",
  },
  format: ["esm"],
  target: "node22",
  outDir: "dist/cli",
  splitting: false,
  sourcemap: true,
  clean: true,
  skipNodeModulesBundle: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
