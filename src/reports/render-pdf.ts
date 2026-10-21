/**
 * HTML -> PDF, rendered by a short-lived headless Chromium.
 *
 * WHY NOT THE WARM BROWSER. `BrowserManager` owns a shared browser that agent
 * tools drive. Report rendering is a background daemon job that must never
 * block on, contend with, or be able to observe an agent's browsing session -
 * and this fleet has a live incident history of chrome process balloons. So
 * this launches its own browser, renders, and closes it, under a single-flight
 * lock: at most ONE report browser exists at a time, process-wide, no matter how
 * many workflows finish together.
 *
 * SECURITY. The HTML is built from model-authored worker output. Three layers,
 * because any one of them can be defeated by a bug in another:
 *  1. `renderMarkdown` escapes before it renders and emits a closed tag set, so
 *     no author-supplied markup exists in the document to begin with.
 *  2. `setContent` - the page never NAVIGATES. There is no origin, so there is
 *     nothing for a same-origin read to reach.
 *  3. `route("**\/*")` aborts every request the page makes. Even if markup did
 *     get through, it could not exfiltrate to, or pull anything from, a network
 *     the daemon can reach - which on this host includes a Tailscale LAN.
 *     `data:` URLs are not routed, so the embedded fonts survive the guard.
 *
 * VERIFIED 2026-08-11 on clawdy: `page.pdf()` works there under the clawcode
 * user with this exact launch + route configuration (Chromium 147.0.7727.15).
 */

import type { Logger } from "pino";

/** Discord's attachment ceiling for a non-boosted guild is 10 MiB. */
export const DISCORD_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Per-operation ceiling (launch, setContent, page.pdf). Generous enough for a
 * 40-page record on a loaded box.
 */
export const RENDER_TIMEOUT_MS = 90_000;

/**
 * Ceiling on the WHOLE batch, which is the number that actually matters.
 *
 * Per-operation timeouts COMPOSE: launch + 2 x (setContent + pdf) would be
 * ~7.5 min at the per-op ceiling. Finalize is awaited by the background job,
 * which the daemon's shutdown drain waits on. `TimeoutStopSec` is 5 min and
 * stops on this host have wedged before, so a deploy landing during a slow
 * render would become a SIGKILL. Nothing downstream would catch it either: the
 * orchestrator's stall recovery watches WORKERS settling, and by finalize the
 * barrier has already passed.
 *
 * 120s is comfortably above a real render (both documents took ~4s on clawdy)
 * and comfortably below the drain.
 */
export const RENDER_BATCH_TIMEOUT_MS = 120_000;

export interface PdfJob {
  /** Complete, self-contained HTML document. */
  readonly html: string;
  /** Chromium footer template (isolated context - inline styles only).
   *  ABSENT = no header/footer chrome at all - required for the tight-margin
   *  mobile report, where the footer band alone would eat 5% of the page. */
  readonly footerHtml?: string;
  /**
   * INC-2026-08-14b — per-job page geometry. Absent = US Letter (the archival
   * record). The authored brief renders PHONE-SHAPED: these PDFs are read from
   * Discord on a phone, and Letter at phone zoom is unreadable.
   */
  readonly page?: {
    readonly width: string;
    readonly height: string;
    readonly margin?: { top: string; bottom: string; left: string; right: string };
  };
}

export interface PdfPageLike {
  route(pattern: string, handler: (route: PdfRouteLike) => unknown): Promise<void>;
  setContent(html: string, options: { waitUntil: "load"; timeout: number }): Promise<void>;
  pdf(options: Record<string, unknown>): Promise<Buffer>;
}
export interface PdfRouteLike {
  request(): { url(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
export interface PdfBrowserLike {
  newPage(options?: { javaScriptEnabled?: boolean }): Promise<PdfPageLike>;
  close(): Promise<void>;
}
export interface PdfDriver {
  launch(): Promise<PdfBrowserLike>;
}

/** Lazily resolves playwright-core so a daemon that never renders never loads it. */
export function defaultPdfDriver(): PdfDriver {
  return {
    async launch(): Promise<PdfBrowserLike> {
      const mod = await import("playwright-core");
      // Pitfall guard, same as BrowserManager: the Chromium sandbox is NOT
      // disabled. If a launch ever fails for sandbox reasons the fix is host
      // configuration, not --no-sandbox on a browser fed model-authored HTML.
      const browser = await mod.chromium.launch({ headless: true, args: [] });
      return browser as unknown as PdfBrowserLike;
    },
  };
}

export interface RenderDeps {
  readonly driver?: PdfDriver;
  readonly logger?: Logger;
  /** Per-operation ceiling. */
  readonly timeoutMs?: number;
  /** Whole-batch ceiling, including the browser launch. */
  readonly batchTimeoutMs?: number;
}

/**
 * Single-flight lock. Chained rather than rejected: two workflows finishing at
 * the same second should both get their PDFs, just not both at once.
 */
let renderChain: Promise<unknown> = Promise.resolve();

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

async function renderBatch(jobs: readonly PdfJob[], deps: RenderDeps): Promise<Buffer[]> {
  const driver = deps.driver ?? defaultPdfDriver();
  const perOp = deps.timeoutMs ?? RENDER_TIMEOUT_MS;
  const batchLimit = deps.batchTimeoutMs ?? RENDER_BATCH_TIMEOUT_MS;
  // The batch deadline is enforced INSIDE the batch, so every operation gets
  // min(perOp, whatever is left). That is what makes the total bounded rather
  // than the sum of the parts - and because the bound is inside, the
  // single-flight lock releases on the same deadline the caller sees, instead
  // of leaving an abandoned browser overlapping the next render.
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1, batchLimit - (Date.now() - startedAt));
  const cap = (): number => Math.min(perOp, remaining());

  const browser = await withTimeout(driver.launch(), cap(), "chromium launch");
  try {
    const out: Buffer[] = [];
    for (const job of jobs) {
      // INC-2026-08-14c — agent-designed documents render with JavaScript OFF
      // (design is CSS-only by contract; scripts are also stripped upstream).
      // Applied to EVERY report render: none of our documents needs JS either.
      const page = await browser.newPage({ javaScriptEnabled: false });
      // Blanket abort BEFORE any content is set, so no request can race the guard.
      await page.route("**/*", (route: PdfRouteLike) => {
        const url = route.request().url();
        return url.startsWith("data:") || url === "about:blank"
          ? route.continue()
          : route.abort();
      });
      await withTimeout(
        page.setContent(job.html, { waitUntil: "load", timeout: cap() }),
        cap(),
        "setContent",
      );
      const buf = await withTimeout(
        page.pdf({
          ...(job.page
            ? { width: job.page.width, height: job.page.height }
            : { format: "Letter" }),
          // Print media drops background fills by default; the stylesheet opts
          // in per-element, and this opts in at the renderer.
          printBackground: true,
          displayHeaderFooter: Boolean(job.footerHtml),
          headerTemplate: "<div></div>",
          footerTemplate: job.footerHtml ?? "<div></div>",
          margin: job.page?.margin ?? { top: "16mm", bottom: "18mm", left: "15mm", right: "15mm" },
        }),
        cap(),
        "page.pdf",
      );
      out.push(Buffer.from(buf));
    }
    return out;
  } finally {
    // A leaked browser here is exactly the chrome-balloon failure this fleet
    // has already had once, so closing is unconditional.
    await browser.close().catch((err: unknown) => {
      deps.logger?.warn(
        { component: "report-render", err: err instanceof Error ? err.message : String(err) },
        "report browser close failed",
      );
    });
  }
}

/**
 * Renders every job on one browser, serialized process-wide.
 *
 * Rejects rather than returning partial output: the caller's contract is
 * "attachments or no attachments", and a brief without its record is a document
 * that points at something the reader was not sent.
 */
export async function renderPdfs(
  jobs: readonly PdfJob[],
  deps: RenderDeps = {},
): Promise<Buffer[]> {
  const start = (): Promise<Buffer[]> => renderBatch(jobs, deps);
  const run = renderChain.then(start, start);
  // Keep the chain alive even when this render fails, or one failure would
  // permanently reject every later render. Chaining on `run` is safe precisely
  // because renderBatch's own deadline bounds it - the lock cannot be held past
  // RENDER_BATCH_TIMEOUT_MS plus the browser close.
  renderChain = run.catch(() => undefined);
  return run;
}

/** True when every buffer fits under Discord's attachment ceiling. */
export function fitsDiscordAttachment(buffers: readonly Buffer[]): boolean {
  return buffers.every((b) => b.byteLength <= DISCORD_ATTACHMENT_MAX_BYTES);
}
