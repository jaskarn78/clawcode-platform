/**
 * Phase 71 — Readability adapter for the web search MCP.
 *
 * Reuses Phase 70's `parseArticle` (src/browser/readability.ts) verbatim
 * instead of hoisting it to `src/shared/` — hoisting is a cross-phase
 * refactor with zero current benefit, and the direct import is stable
 * because the Phase 70 module exports a frozen ArticleResult shape.
 *
 * A thin wrapper exists (rather than re-exporting `parseArticle` directly)
 * so Phase 71 can evolve the adapter surface — e.g., adding a `lang`
 * constraint or a fallback extractor — without touching the browser module.
 */

import { parseArticle, type ArticleResult } from "../browser/readability.js";

/**
 * Extract an article from rendered HTML. Returns `null` when Readability
 * cannot identify the input as an article (login page, bare SPA shell,
 * etc.) — callers in tools.ts map the null into a structured
 * `extraction_failed` error.
 */
export async function extractArticle(
  html: string,
  baseUrl: string,
): Promise<ArticleResult | null> {
  return parseArticle(html, baseUrl);
}

export type { ArticleResult };
