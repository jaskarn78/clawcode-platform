import { defineConfig, type PluginOption } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'

// Phase 116 / dashboard-rework — ClawCode dashboard v2 SPA.
//
// Build output flows into the daemon's dist/dashboard/spa directory so the
// production bundle (built by the root `npm run build` script via
// `npm run build:spa`) ships alongside dist/cli/index.js.
//
// dashboard-rework decision 4 (2026-06-15): base flipped '/dashboard/v2/' → '/'
// so the SPA serves at the root URL. The daemon's server.ts serves these assets
// at '/' and 301-redirects legacy '/dashboard/v2/*' → '/*'.
//
// Single-root-node_modules pattern: all dependencies live in the repo-root
// package.json; Vite resolves them via parent-directory module resolution.

// Dev-only read-only guard. The dev server proxies /api + /preview to the LIVE
// production daemon (http://10.0.0.5:3100) so the UI renders against real
// data while iterating. This middleware HARD-BLOCKS any non-GET request to those
// paths so a stray click / automated UI audit can never fire a mutation
// (agent restart/stop, key revoke, config write, daemon restart) at prod.
function devReadOnlyGuard(): PluginOption {
  return {
    name: 'dev-readonly-proxy-guard',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        const guarded = url.startsWith('/api') || url.startsWith('/preview')
        const method = (req.method ?? 'GET').toUpperCase()
        const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
        if (guarded && !safe) {
          res.statusCode = 403
          res.setHeader('content-type', 'application/json')
          res.end(
            JSON.stringify({
              error:
                'dev proxy is READ-ONLY — mutations are blocked from hitting the live daemon',
              method,
              url,
            }),
          )
          return
        }
        next()
      })
    },
  }
}

const DAEMON = process.env.CLAWCODE_DEV_PROXY_TARGET ?? 'http://10.0.0.5:3100'

export default defineConfig({
  plugins: [react(), devReadOnlyGuard()],
  base: '/',
  build: {
    // Resolve relative to the client root (this file's directory).
    // ../../../dist/dashboard/spa lands at: workspace-root/dist/dashboard/spa
    outDir: path.resolve(__dirname, '../../../dist/dashboard/spa'),
    emptyOutDir: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    proxy: {
      // Read-only GET/SSE passthrough to the live daemon. SSE (/api/events)
      // works over this proxy (plain chunked HTTP; no ws upgrade needed).
      '/api': { target: DAEMON, changeOrigin: true },
      '/preview': { target: DAEMON, changeOrigin: true },
    },
  },
})
