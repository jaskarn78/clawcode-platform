import type { BrowserLogger } from "./types.js";

/**
 * Phase 70 — article extraction via @mozilla/readability + jsdom.
 *
 * Plan 02 consumer: `browserExtract(ctx, {mode:"readability"})` in tools.ts.
 *
 * Design notes:
 *   - Lazy imports of both `jsdom` and `@mozilla/readability` inside the
 *     function (mirrors the embedder.ts pattern) — keeps module load cheap
 *     even when browser_extract is never called with mode=readability.
 *   - Returns the FULL metadata superset per 70-RESEARCH.md Open Q #5.
 *     Agents ignore fields they don't need; having all of them is cheaper
 *     than iterating the schema later.
 *   - Result is `Object.freeze`d per CLAUDE.md immutability rule.
 *   - JSDOM is closed in a `finally` block — without this the JSDOM window
 *     leaks for the lifetime of the daemon.
 */

/**
 * Readability's full metadata superset. `null` rather than `undefined` for
 * missing values so the shape is stable across calls and JSON serialization
 * does not elide missing fields (agents can safely destructure + null-check).
 */
export interface ArticleResult {
  readonly title: string | null;
  readonly byline: string | null;
  readonly siteName: string | null;
  readonly publishedTime: string | null;
  readonly lang: string | null;
  readonly excerpt: string | null;
  readonly text: string;
  readonly html: string;
  readonly length: number;
}

/**
 * Parse rendered HTML through @mozilla/readability.
 *
 * Returns `null` when Readability cannot identify the input as an article
 * (e.g. a login page, a bare SPA shell). Callers — specifically
 * `browserExtract(mode="readability")` — convert this null into a
 * structured `{type:"internal"}` error so agents see a clear failure
 * rather than a silently empty result.
 *
 * `baseUrl` is required: Readability resolves relative links in the
 * article content against it, and jsdom needs it for the Document URL.
 */
export async function parseArticle(
  html: string,
  baseUrl: string,
  log?: BrowserLogger,
): Promise<ArticleResult | null> {
  const { JSDOM } = await import("jsdom");
  const { Readability } = await import("@mozilla/readability");

  const dom = new JSDOM(html, { url: baseUrl });
  try {
    const reader = new Readability(dom.window.document);
    const article = reader.parse();
    if (!article) return null;

    // Collapse whitespace runs so agents see clean text, not raw inner text
    // with newlines / tabs / blank lines.
    const rawText = article.textContent ?? "";
    const text = rawText.replace(/\s+/g, " ").trim();

    return Object.freeze({
      title: article.title ?? null,
      byline: article.byline ?? null,
      siteName: article.siteName ?? null,
      publishedTime: article.publishedTime ?? null,
      lang: article.lang ?? null,
      excerpt: article.excerpt ?? null,
      text,
      html: article.content ?? "",
      length: text.length,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.warn({ err: msg }, "readability parse threw");
    return null;
  } finally {
    // Release JSDOM resources — without this the window + its timers
    // survive for the lifetime of the daemon.
    dom.window.close();
  }
}
