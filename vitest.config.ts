import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  // dash-redesign — `@/` alias mirrors the dashboard SPA's
  // src/dashboard/client/tsconfig.app.json + vite.config.ts. Required so
  // vitest can resolve `import … from "@/hooks/useApi"` inside the SPA
  // sources (and their colocated test files) when vitest is invoked
  // from the repo root. Non-SPA source files don't use this alias; the
  // mapping is harmless to them.
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/dashboard/client/src"),
    },
  },
  test: {
    globals: false,
    // Exclude stale copies of the project under .claude/worktrees that contain
    // outdated test files (e.g. src/mcp/server.test.ts with old tool counts).
    // These are scratch copies from prior agent runs — not part of the main tree.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/cypress/**",
      "**/.{idea,git,cache,output,temp}/**",
      "**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*",
      ".claude/worktrees/**",
    ],
  },
});
