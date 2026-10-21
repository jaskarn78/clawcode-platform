import { describe, it, expect, vi } from "vitest";
import {
  renderPdfs,
  fitsDiscordAttachment,
  DISCORD_ATTACHMENT_MAX_BYTES,
  type PdfDriver,
  type PdfRouteLike,
} from "../render-pdf.js";

/** A fake browser that records what the page was allowed to fetch. */
function fakeDriver(opts: { failLaunch?: boolean; failPdf?: boolean; hangPdf?: boolean } = {}) {
  const state = {
    launches: 0,
    closes: 0,
    pages: 0,
    aborted: [] as string[],
    continued: [] as string[],
    concurrent: 0,
    maxConcurrent: 0,
    routeRegisteredBeforeContent: [] as boolean[],
  };
  const driver: PdfDriver = {
    async launch() {
      if (opts.failLaunch) throw new Error("launch boom");
      state.launches += 1;
      state.concurrent += 1;
      state.maxConcurrent = Math.max(state.maxConcurrent, state.concurrent);
      return {
        async newPage() {
          state.pages += 1;
          let routed = false;
          return {
            async route(_pattern: string, handler: (r: PdfRouteLike) => unknown) {
              routed = true;
              // Drive the handler with the URL classes a real page produces.
              for (const url of [
                "data:font/woff2;base64,AAA",
                "https://fonts.gstatic.com/x.woff2",
                "http://10.0.0.5/internal",
                "about:blank",
              ]) {
                await handler({
                  request: () => ({ url: () => url }),
                  abort: async () => {
                    state.aborted.push(url);
                  },
                  continue: async () => {
                    state.continued.push(url);
                  },
                });
              }
            },
            async setContent() {
              state.routeRegisteredBeforeContent.push(routed);
            },
            async pdf() {
              if (opts.failPdf) throw new Error("pdf boom");
              if (opts.hangPdf) await new Promise(() => {});
              return Buffer.from("%PDF-1.4 fake");
            },
          };
        },
        async close() {
          state.concurrent -= 1;
          state.closes += 1;
        },
      };
    },
  };
  return { driver, state };
}

const job = (n: string) => ({ html: `<html>${n}</html>`, footerHtml: "<div></div>" });

describe("renderPdfs — the network guard", () => {
  it("aborts every non-data request and lets data: through", async () => {
    // The report HTML is model-authored, and this daemon can reach a Tailscale
    // LAN. The abort is what makes that safe; the data: exception is what makes
    // the embedded fonts render.
    const { driver, state } = fakeDriver();
    await renderPdfs([job("a")], { driver });
    expect(state.continued).toContain("data:font/woff2;base64,AAA");
    expect(state.aborted).toContain("https://fonts.gstatic.com/x.woff2");
    expect(state.aborted).toContain("http://10.0.0.5/internal");
  });

  it("registers the route BEFORE any content is set", async () => {
    // A route installed after setContent races the page's own requests.
    const { driver, state } = fakeDriver();
    await renderPdfs([job("a"), job("b")], { driver });
    expect(state.routeRegisteredBeforeContent).toEqual([true, true]);
  });
});

describe("renderPdfs — resource discipline", () => {
  it("renders a batch on ONE browser", async () => {
    const { driver, state } = fakeDriver();
    const out = await renderPdfs([job("a"), job("b")], { driver });
    expect(out).toHaveLength(2);
    expect(state.launches).toBe(1);
    expect(state.pages).toBe(2);
    expect(state.closes).toBe(1);
  });

  it("closes the browser even when the render throws", async () => {
    // A leaked browser is precisely this fleet's chrome-balloon failure mode.
    const { driver, state } = fakeDriver({ failPdf: true });
    await expect(renderPdfs([job("a")], { driver })).rejects.toThrow("pdf boom");
    expect(state.closes).toBe(1);
  });

  it("never runs two report browsers at once", async () => {
    const { driver, state } = fakeDriver();
    await Promise.all([
      renderPdfs([job("a")], { driver }),
      renderPdfs([job("b")], { driver }),
      renderPdfs([job("c")], { driver }),
    ]);
    expect(state.maxConcurrent).toBe(1);
    expect(state.launches).toBe(3);
  });

  it("a failed render does not poison the queue for the next one", async () => {
    const bad = fakeDriver({ failPdf: true });
    const good = fakeDriver();
    await expect(renderPdfs([job("a")], { driver: bad.driver })).rejects.toThrow();
    await expect(renderPdfs([job("b")], { driver: good.driver })).resolves.toHaveLength(1);
  });

  it("bounds the WHOLE batch, not just each operation", async () => {
    // Per-op ceilings compose to ~7.5 min, past the daemon's 5-min stop
    // timeout; finalize is inside the shutdown drain, so only a batch deadline
    // keeps a slow render from turning a deploy into a SIGKILL.
    const { driver } = fakeDriver({ hangPdf: true });
    await expect(
      renderPdfs([job("a")], { driver, timeoutMs: 60_000, batchTimeoutMs: 40 }),
    ).rejects.toThrow(/timed out after/);
  });

  it("releases the single-flight lock on the batch deadline, not the per-op one", async () => {
    // The lock must not outlive the caller's deadline; if it did, a wedged
    // render would stall every later workflow's finalize for the per-op
    // ceiling on top of its own.
    const wedged = fakeDriver({ hangPdf: true });
    const healthy = fakeDriver();
    await expect(
      renderPdfs([job("a")], { driver: wedged.driver, timeoutMs: 60_000, batchTimeoutMs: 40 }),
    ).rejects.toThrow();
    // Would hang for 60s if the lock were held by the per-op timeout.
    await expect(renderPdfs([job("b")], { driver: healthy.driver })).resolves.toHaveLength(1);
    expect(wedged.state.closes).toBe(1);
  });

  it("times out rather than hanging on a wedged Chromium", async () => {
    const { driver, state } = fakeDriver({ hangPdf: true });
    await expect(renderPdfs([job("a")], { driver, timeoutMs: 30 })).rejects.toThrow(/timed out/);
    expect(state.closes).toBe(1);
  });

  it("propagates a launch failure without claiming a browser", async () => {
    const { driver, state } = fakeDriver({ failLaunch: true });
    await expect(renderPdfs([job("a")], { driver })).rejects.toThrow("launch boom");
    expect(state.closes).toBe(0);
  });
});

describe("fitsDiscordAttachment", () => {
  it("accepts buffers at the ceiling and rejects one over it", () => {
    expect(fitsDiscordAttachment([Buffer.alloc(DISCORD_ATTACHMENT_MAX_BYTES)])).toBe(true);
    expect(fitsDiscordAttachment([Buffer.alloc(DISCORD_ATTACHMENT_MAX_BYTES + 1)])).toBe(false);
  });
  it("is false when ANY buffer is over, not just the first", () => {
    expect(
      fitsDiscordAttachment([Buffer.alloc(10), Buffer.alloc(DISCORD_ATTACHMENT_MAX_BYTES + 1)]),
    ).toBe(false);
  });
});
