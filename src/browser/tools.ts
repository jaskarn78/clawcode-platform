import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { BrowserError, toBrowserToolError } from "./errors.js";
import { parseArticle } from "./readability.js";
import { resolveScreenshotSavePath } from "./screenshot.js";
import type {
  BrowserContext,
  BrowserToolError,
  BrowserToolOutcome,
} from "./types.js";

/**
 * Phase 70 Plan 02 — 6 PURE browser tool handlers.
 *
 * Each handler:
 *   - Takes `(ctx: BrowserContext, args, cfg)` and returns a
 *     `BrowserToolOutcome<T>` — NEVER throws.
 *   - Maps Playwright errors through `toBrowserToolError` into the
 *     locked error taxonomy (timeout, element_not_found, ...).
 *   - Has ZERO references to BrowserManager, IPC, or the MCP SDK —
 *     tests mock just the BrowserContext surface.
 *
 * Tool surface is LOCKED by 70-CONTEXT.md "Tool Surface" table.
 * DO NOT change argument shapes or return shapes without amending
 * CONTEXT.md first.
 *
 * Description steering (70-RESEARCH.md Pitfalls 3 / 4 / 7):
 *   - browser_navigate: avoid `networkidle` as default (hangs on SPAs).
 *   - browser_click / fill / wait_for: prefer role/text/testid over CSS.
 *   - browser_screenshot: default to path-based workflow for repeats.
 */

/**
 * Config passed to every tool handler. The daemon-side wiring (Plan 03)
 * will read the resolved `defaults.browser` schema and hand this to
 * tools.ts; the MCP subprocess layer passes it through verbatim.
 */
export interface BrowserToolConfig {
  readonly navigationTimeoutMs: number;
  readonly actionTimeoutMs: number;
  readonly maxScreenshotInlineBytes: number;
  /** Directory base for screenshot saves — typically `<workspace>`. */
  readonly screenshotDir: string;
}

/* ------------------------------------------------------------------ */
/*  Minimal Playwright Page surface we rely on                         */
/*  (kept narrow so tools.ts stays decoupled from playwright-core)     */
/* ------------------------------------------------------------------ */

interface PageLike {
  url(): string;
  title(): Promise<string>;
  content(): Promise<string>;
  goto(
    url: string,
    opts?: { waitUntil?: string; timeout?: number },
  ): Promise<ResponseLike | null>;
  screenshot(opts: {
    fullPage?: boolean;
    type?: string;
    timeout?: number;
  }): Promise<Buffer>;
  locator(selector: string): LocatorLike;
  waitForURL(url: RegExp, opts?: { timeout?: number }): Promise<void>;
  waitForLoadState(
    state?: "load" | "domcontentloaded" | "networkidle",
    opts?: { timeout?: number },
  ): Promise<void>;
}

interface ResponseLike {
  status(): number;
}

interface LocatorLike {
  click(opts?: { timeout?: number }): Promise<void>;
  fill(value: string, opts?: { timeout?: number }): Promise<void>;
  textContent(opts?: { timeout?: number }): Promise<string | null>;
  innerHTML(opts?: { timeout?: number }): Promise<string>;
  first(): LocatorLike;
  waitFor(opts?: { state?: string; timeout?: number }): Promise<void>;
}

/**
 * Context shape we rely on — narrower than playwright-core's full
 * BrowserContext but structurally compatible. The real
 * BrowserContext.pages() returns Page[]; we consume a handful of
 * methods from the first page (or create a new one on demand).
 */
interface ContextLike {
  pages(): readonly PageLike[];
  newPage(): Promise<PageLike>;
}

/* ------------------------------------------------------------------ */
/*  get-or-create active page                                          */
/* ------------------------------------------------------------------ */

async function getActivePage(ctx: BrowserContext): Promise<PageLike> {
  const pages = (ctx as unknown as ContextLike).pages();
  if (pages.length > 0) return pages[0];
  return (ctx as unknown as ContextLike).newPage();
}

/* ------------------------------------------------------------------ */
/*  Tool descriptions (steering text for agents)                       */
/* ------------------------------------------------------------------ */

const NAV_DESC =
  "Open a URL in your browser and wait for the page to load. " +
  "Use waitUntil='load' (default) for most pages. Use 'domcontentloaded' " +
  "for fast-rendering SPAs. AVOID 'networkidle' — it hangs on pages with " +
  "live polling or analytics.";

const SCREENSHOT_DESC =
  "Capture a PNG screenshot of the current page. Saves to disk and " +
  "optionally inlines base64 for immediate vision. For repeated captures " +
  "in one task, rely on the returned path — Claude can Read them on " +
  "demand, which avoids filling conversation history with base64 payloads.";

const CLICK_DESC =
  "Click an element by selector. Prefer getByRole() / getByTestId() / " +
  "getByText() selectors over raw CSS classes — they are resilient to " +
  "DOM churn and redesigns.";

const FILL_DESC =
  "Fill a form field by selector. Prefer getByRole() / getByTestId() / " +
  "getByText() selectors over raw CSS classes — they are resilient to " +
  "DOM churn.";

const EXTRACT_DESC =
  "Extract content from the page. mode='selector' returns textContent " +
  "and innerHTML for a specific locator. mode='readability' runs the " +
  "Mozilla Readability algorithm over the full page for article-style " +
  "content extraction with title, byline, publishedTime metadata.";

const WAIT_FOR_DESC =
  "Wait for a condition: a selector to become visible, a URL regex to " +
  "match, or both (whichever fires first). Returns a structured timeout " +
  "result rather than throwing when the condition is not met. Prefer " +
  "getByRole() / getByTestId() / getByText() selectors over raw CSS.";

/* ------------------------------------------------------------------ */
/*  Tool definitions — consumed by mcp-server.ts                       */
/* ------------------------------------------------------------------ */

type ZodNs = typeof import("zod/v4").z;

export interface ToolDefinition {
  readonly name:
    | "browser_navigate"
    | "browser_screenshot"
    | "browser_click"
    | "browser_fill"
    | "browser_extract"
    | "browser_wait_for";
  readonly description: string;
  readonly schemaBuilder: (z: ZodNs) => Record<string, unknown>;
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "browser_navigate",
    description: NAV_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      url: z.string().describe("URL to navigate to (http:// or https:// only)"),
      waitUntil: z
        .enum(["load", "domcontentloaded", "networkidle"])
        .optional()
        .describe(
          "When to consider navigation done. Default 'load'. Avoid 'networkidle' on SPAs.",
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Navigation timeout override; falls back to daemon config."),
      agent: z
        .string()
        .optional()
        .describe(
          "Your agent name — injected by the MCP client or set via CLAWCODE_AGENT env.",
        ),
    }),
  },
  {
    name: "browser_screenshot",
    description: SCREENSHOT_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      fullPage: z
        .boolean()
        .optional()
        .describe("Capture the full scrollable page. Default false."),
      savePath: z
        .string()
        .optional()
        .describe(
          "Optional absolute path override. Default: <workspace>/browser/screenshots/<date>/<id>.png.",
        ),
      agent: z
        .string()
        .optional()
        .describe(
          "Your agent name — injected by the MCP client or set via CLAWCODE_AGENT env.",
        ),
    }),
  },
  {
    name: "browser_click",
    description: CLICK_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      selector: z
        .string()
        .describe(
          "Playwright selector — prefer role/testid/text over raw CSS classes.",
        ),
      timeoutMs: z.number().int().positive().optional(),
      agent: z.string().optional(),
    }),
  },
  {
    name: "browser_fill",
    description: FILL_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      selector: z
        .string()
        .describe(
          "Playwright selector — prefer role/testid/text over raw CSS classes.",
        ),
      value: z.string().describe("Value to type into the field."),
      timeoutMs: z.number().int().positive().optional(),
      agent: z.string().optional(),
    }),
  },
  {
    name: "browser_extract",
    description: EXTRACT_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      mode: z
        .enum(["selector", "readability"])
        .describe("'selector' = CSS/role/testid query; 'readability' = article mode."),
      selector: z
        .string()
        .optional()
        .describe("Required when mode='selector'. Prefer role/testid/text."),
      agent: z.string().optional(),
    }),
  },
  {
    name: "browser_wait_for",
    description: WAIT_FOR_DESC,
    schemaBuilder: (z: ZodNs): Record<string, unknown> => ({
      selector: z
        .string()
        .optional()
        .describe(
          "Selector to wait for (visible). Prefer role/testid/text over CSS.",
        ),
      url: z
        .string()
        .optional()
        .describe("URL regex to wait for (string compiled to RegExp)."),
      timeoutMs: z.number().int().positive().optional(),
      agent: z.string().optional(),
    }),
  },
]);

/* ------------------------------------------------------------------ */
/*  Error classification helpers                                       */
/* ------------------------------------------------------------------ */

function isTimeoutError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "TimeoutError" ||
      err.message.toLowerCase().includes("timeout"))
  );
}

/** Map action-timeout (click/fill/wait_for) errors to element_not_found. */
function mapActionError(
  err: unknown,
  selector: string | undefined,
  timeoutMs: number,
): BrowserToolError {
  if (isTimeoutError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "element_not_found" as const,
        message,
        ...(selector !== undefined ? { selector } : {}),
        timeoutMs,
      }),
    });
  }
  return toBrowserToolError(err);
}

/* ------------------------------------------------------------------ */
/*  browser_navigate                                                   */
/* ------------------------------------------------------------------ */

export async function browserNavigate(
  ctx: BrowserContext,
  args: {
    url: string;
    waitUntil?: "load" | "domcontentloaded" | "networkidle";
    timeoutMs?: number;
  },
  cfg: BrowserToolConfig,
): Promise<
  BrowserToolOutcome<{ url: string; title: string; status: number }>
> {
  // Validate URL at the tool boundary — rejects file://, javascript:, etc.
  let parsed: URL;
  try {
    parsed = new URL(args.url);
  } catch {
    return toBrowserToolError(
      new BrowserError("invalid_argument", `malformed url: ${args.url}`),
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return toBrowserToolError(
      new BrowserError(
        "invalid_argument",
        `only http:// and https:// URLs allowed; got ${parsed.protocol}`,
      ),
    );
  }

  const waitUntil = args.waitUntil ?? "load";
  const timeout = args.timeoutMs ?? cfg.navigationTimeoutMs;

  try {
    const page = await getActivePage(ctx);
    const response = await page.goto(args.url, { waitUntil, timeout });
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        url: page.url(),
        title: await page.title(),
        status: response?.status() ?? 0,
      }),
    });
  } catch (err) {
    if (isTimeoutError(err)) {
      const message = err instanceof Error ? err.message : String(err);
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({
          type: "timeout" as const,
          message,
          timeoutMs: timeout,
        }),
      });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Object.freeze({
      ok: false as const,
      error: Object.freeze({
        type: "navigation_failed" as const,
        message,
      }),
    });
  }
}

/* ------------------------------------------------------------------ */
/*  browser_screenshot                                                 */
/* ------------------------------------------------------------------ */

export async function browserScreenshot(
  ctx: BrowserContext,
  args: { fullPage?: boolean; savePath?: string },
  cfg: BrowserToolConfig,
): Promise<
  BrowserToolOutcome<{ path: string; bytes: number; inlineBase64?: string }>
> {
  try {
    const page = await getActivePage(ctx);
    const buffer = await page.screenshot({
      fullPage: args.fullPage ?? false,
      type: "png",
    });
    const finalPath = resolveScreenshotSavePath(cfg.screenshotDir, args.savePath);
    await mkdir(dirname(finalPath), { recursive: true });
    await writeFile(finalPath, buffer);

    const bytes = buffer.length;
    const shouldInline =
      cfg.maxScreenshotInlineBytes > 0 && bytes <= cfg.maxScreenshotInlineBytes;

    const data: {
      path: string;
      bytes: number;
      inlineBase64?: string;
    } = { path: finalPath, bytes };
    if (shouldInline) data.inlineBase64 = buffer.toString("base64");

    return Object.freeze({ ok: true as const, data: Object.freeze(data) });
  } catch (err) {
    return toBrowserToolError(err);
  }
}

/* ------------------------------------------------------------------ */
/*  browser_click                                                      */
/* ------------------------------------------------------------------ */

export async function browserClick(
  ctx: BrowserContext,
  args: { selector: string; timeoutMs?: number },
  cfg: BrowserToolConfig,
): Promise<
  BrowserToolOutcome<{ clicked: true; selector: string; newUrl?: string }>
> {
  const timeout = args.timeoutMs ?? cfg.actionTimeoutMs;
  try {
    const page = await getActivePage(ctx);
    const urlBefore = page.url();
    await page.locator(args.selector).click({ timeout });
    // Best-effort wait for a possible post-click navigation. We cap at 1s
    // so clicks that do not navigate return promptly.
    await page
      .waitForLoadState("load", { timeout: 1000 })
      .catch(() => {
        /* no navigation happened; that's fine */
      });
    const urlAfter = page.url();
    const data: { clicked: true; selector: string; newUrl?: string } = {
      clicked: true,
      selector: args.selector,
    };
    if (urlBefore !== urlAfter) data.newUrl = urlAfter;
    return Object.freeze({ ok: true as const, data: Object.freeze(data) });
  } catch (err) {
    return mapActionError(err, args.selector, timeout);
  }
}

/* ------------------------------------------------------------------ */
/*  browser_fill                                                       */
/* ------------------------------------------------------------------ */

export async function browserFill(
  ctx: BrowserContext,
  args: { selector: string; value: string; timeoutMs?: number },
  cfg: BrowserToolConfig,
): Promise<BrowserToolOutcome<{ filled: true; selector: string }>> {
  const timeout = args.timeoutMs ?? cfg.actionTimeoutMs;
  try {
    const page = await getActivePage(ctx);
    await page.locator(args.selector).fill(args.value, { timeout });
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({ filled: true as const, selector: args.selector }),
    });
  } catch (err) {
    return mapActionError(err, args.selector, timeout);
  }
}

/* ------------------------------------------------------------------ */
/*  browser_extract                                                    */
/* ------------------------------------------------------------------ */

export type ExtractResult =
  | {
      readonly mode: "selector";
      readonly selector: string;
      readonly text: string;
      readonly html: string;
    }
  | {
      readonly mode: "readability";
      readonly title: string | null;
      readonly byline: string | null;
      readonly siteName: string | null;
      readonly publishedTime: string | null;
      readonly lang: string | null;
      readonly excerpt: string | null;
      readonly text: string;
      readonly html: string;
      readonly length: number;
    };

export async function browserExtract(
  ctx: BrowserContext,
  args: { mode: "selector" | "readability"; selector?: string },
  cfg: BrowserToolConfig,
): Promise<BrowserToolOutcome<ExtractResult>> {
  try {
    const page = await getActivePage(ctx);

    if (args.mode === "selector") {
      if (!args.selector) {
        return toBrowserToolError(
          new BrowserError(
            "invalid_argument",
            "selector required for mode=selector",
          ),
        );
      }
      const loc = page.locator(args.selector).first();
      const text =
        (await loc.textContent({ timeout: cfg.actionTimeoutMs })) ?? "";
      const html = await loc.innerHTML({ timeout: cfg.actionTimeoutMs });
      return Object.freeze({
        ok: true as const,
        data: Object.freeze({
          mode: "selector" as const,
          selector: args.selector,
          text,
          html,
        }),
      });
    }

    // mode === "readability"
    const html = await page.content();
    const baseUrl = page.url();
    const article = await parseArticle(html, baseUrl);
    if (article === null) {
      return toBrowserToolError(
        new BrowserError(
          "internal",
          "Readability could not extract article content",
        ),
      );
    }
    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        mode: "readability" as const,
        title: article.title,
        byline: article.byline,
        siteName: article.siteName,
        publishedTime: article.publishedTime,
        lang: article.lang,
        excerpt: article.excerpt,
        text: article.text,
        html: article.html,
        length: article.length,
      }),
    });
  } catch (err) {
    return mapActionError(err, args.selector, cfg.actionTimeoutMs);
  }
}

/* ------------------------------------------------------------------ */
/*  browser_wait_for                                                   */
/* ------------------------------------------------------------------ */

export async function browserWaitFor(
  ctx: BrowserContext,
  args: { selector?: string; url?: string; timeoutMs?: number },
  cfg: BrowserToolConfig,
): Promise<BrowserToolOutcome<{ matched: boolean; elapsedMs: number }>> {
  if (!args.selector && !args.url) {
    return toBrowserToolError(
      new BrowserError(
        "invalid_argument",
        "at least one of selector or url required",
      ),
    );
  }

  const timeout = args.timeoutMs ?? cfg.actionTimeoutMs;
  let urlRegex: RegExp | undefined;
  if (args.url !== undefined) {
    try {
      urlRegex = new RegExp(args.url);
    } catch {
      return toBrowserToolError(
        new BrowserError("invalid_argument", `invalid url regex: ${args.url}`),
      );
    }
  }

  const started = Date.now();
  try {
    const page = await getActivePage(ctx);
    const races: Promise<unknown>[] = [];
    if (args.selector) {
      races.push(
        page
          .locator(args.selector)
          .first()
          .waitFor({ state: "visible", timeout }),
      );
    }
    if (urlRegex) {
      races.push(page.waitForURL(urlRegex, { timeout }));
    }
    await Promise.race(races);

    return Object.freeze({
      ok: true as const,
      data: Object.freeze({
        matched: true,
        elapsedMs: Date.now() - started,
      }),
    });
  } catch (err) {
    // BROWSER-05 contract: timeouts return a structured result, NEVER throw.
    if (isTimeoutError(err)) {
      return Object.freeze({
        ok: false as const,
        error: Object.freeze({
          type: "timeout" as const,
          message: err instanceof Error ? err.message : "wait_for timed out",
          ...(args.selector !== undefined ? { selector: args.selector } : {}),
          timeoutMs: timeout,
        }),
      });
    }
    return toBrowserToolError(err);
  }
}
