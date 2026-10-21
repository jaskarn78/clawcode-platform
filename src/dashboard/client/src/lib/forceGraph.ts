/**
 * Typed facade over the self-contained, vendored `force-graph` build.
 *
 * WHY VENDORED (not an npm dep): client/package.json documents a hard rule —
 * "ALL dependencies live in the repo-root package.json (single node_modules)"
 * because a client-local node_modules risks a second React copy → broken hooks.
 * force-graph is React-free, but rather than bend that rule (or mutate the
 * shared root node_modules in this worktree workflow) we vendor a standalone,
 * deps-inlined ESM bundle as source. Vite code-splits it onto the lazy graph
 * route, so it never touches the main bundle.
 *
 * Source: force-graph@1.51.4 (MIT © vasturiano). Regenerate after a version
 * bump with:
 *   cd src/dashboard/client \
 *     && npm i --no-save force-graph@<version> \
 *     && esbuild node_modules/force-graph/dist/force-graph.mjs \
 *          --bundle --format=esm --legal-comments=none \
 *          --outfile=src/vendor/force-graph.mjs \
 *     && rm -rf node_modules
 */
// @ts-ignore — vendored standalone JS bundle ships no type declarations.
import ForceGraphFactory from '../vendor/force-graph.mjs'

/**
 * The force-graph instance is a fluent builder: every configuration method
 * returns the instance. We type it structurally as a chainable, callable
 * surface — strict enough for our call sites without re-deriving the lib's
 * full ambient types.
 */
export interface ForceGraphInstance {
  (element: HTMLElement): ForceGraphInstance
  // Fluent config — each returns the instance (or the current value when
  // called with no arg). Typed loosely on purpose; call sites stay readable.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [method: string]: any
}

export type ForceGraphFactoryFn = () => ForceGraphInstance

const ForceGraph = ForceGraphFactory as unknown as ForceGraphFactoryFn
export default ForceGraph
