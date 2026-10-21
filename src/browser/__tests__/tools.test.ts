import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import {
  browserNavigate,
  browserScreenshot,
  browserClick,
  browserFill,
  browserExtract,
  browserWaitFor,
  TOOL_DEFINITIONS,
  type BrowserToolConfig,
} from "../tools.js";
import type { BrowserContext } from "../types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, "fixtures");

/* ------------------------------------------------------------------ */
/*  Mocks — narrow Playwright Page/Locator surface                     */
/* ------------------------------------------------------------------ */

interface FakeLocator {
  click: ReturnType<typeof vi.fn>;
  fill: ReturnType<typeof vi.fn>;
  textContent: ReturnType<typeof vi.fn>;
  innerHTML: ReturnType<typeof vi.fn>;
  first: () => FakeLocator;
  waitFor: ReturnType<typeof vi.fn>;
}

interface FakePage {
  _url: string;
  _title: string;
  _content: string;
  url: () => string;
  title: ReturnType<typeof vi.fn>;
  content: ReturnType<typeof vi.fn>;
  goto: ReturnType<typeof vi.fn>;
  screenshot: ReturnType<typeof vi.fn>;
  locator: ReturnType<typeof vi.fn>;
  waitForURL: ReturnType<typeof vi.fn>;
  waitForLoadState: ReturnType<typeof vi.fn>;
  _locators: Map<string, FakeLocator>;
}

function makeTimeoutError(msg = "locator.click: Timeout 10000ms exceeded."): Error {
  const err = new Error(msg);
  err.name = "TimeoutError";
  return err;
}

function makeLocator(overrides: Partial<FakeLocator> = {}): FakeLocator {
  const loc: FakeLocator = {
    click: vi.fn(async () => {}),
    fill: vi.fn(async () => {}),
    textContent: vi.fn(async () => "text-content"),
    innerHTML: vi.fn(async () => "<span>html</span>"),
    first: () => loc,
    waitFor: vi.fn(async () => {}),
    ...overrides,
  };
  // Re-bind first() in case overrides replaced it
  if (!overrides.first) loc.first = () => loc;
  return loc;
}

function makePage(init: {
  url?: string;
  title?: string;
  content?: string;
} = {}): FakePage {
  const page: FakePage = {
    _url: init.url ?? "about:blank",
    _title: init.title ?? "",
    _content: init.content ?? "<html></html>",
    url: () => page._url,
    title: vi.fn(async () => page._title),
    content: vi.fn(async () => page._content),
    goto: vi.fn(async (url: string) => {
      page._url = url;
      return { status: () => 200 };
    }),
    screenshot: vi.fn(async () => Buffer.alloc(128, 0xab)),
    locator: vi.fn((sel: string) => {
      const existing = page._locators.get(sel);
      if (existing) return existing;
      const loc = makeLocator();
      page._locators.set(sel, loc);
      return loc;
    }),
    waitForURL: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    _locators: new Map(),
  };
  return page;
}

function makeCtx(pages: FakePage[] = []): { ctx: BrowserContext; pages: FakePage[] } {
  const list = pages.length > 0 ? pages : [makePage()];
  const ctx = {
    pages: () => list,
    newPage: vi.fn(async () => {
      const p = makePage();
      list.push(p);
      return p;
    }),
  } as unknown as BrowserContext;
  return { ctx, pages: list };
}

const DEFAULT_CFG: BrowserToolConfig = {
  navigationTimeoutMs: 30000,
  actionTimeoutMs: 10000,
  maxScreenshotInlineBytes: 512 * 1024,
  screenshotDir: "/workspace",
};

/* ------------------------------------------------------------------ */
/*  browserNavigate                                                    */
/* ------------------------------------------------------------------ */

describe("browserNavigate", () => {
  it("returns {url, title, status} on success", async () => {
    const { ctx, pages } = makeCtx([makePage({ title: "Example" })]);
    pages[0].goto = vi.fn(async (url: string) => {
      pages[0]._url = url;
      pages[0]._title = "Loaded Title";
      return { status: () => 201 };
    });
    const out = await browserNavigate(
      ctx,
      { url: "https://example.com/" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.url).toBe("https://example.com/");
      expect(out.data.title).toBe("Loaded Title");
      expect(out.data.status).toBe(201);
    }
  });

  it("rejects malformed URL with invalid_argument", async () => {
    const { ctx } = makeCtx();
    const out = await browserNavigate(
      ctx,
      { url: "not a url" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("invalid_argument");
      expect(out.error.message).toContain("malformed url");
    }
  });

  it("rejects non-http(s) schemes with invalid_argument", async () => {
    const { ctx } = makeCtx();
    const out = await browserNavigate(
      ctx,
      { url: "file:///etc/passwd" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("invalid_argument");
      expect(out.error.message).toContain("http://");
    }
  });

  it("maps Playwright TimeoutError to {type: 'timeout'} with timeoutMs", async () => {
    const page = makePage();
    page.goto = vi.fn(async () => {
      throw makeTimeoutError("nav timeout");
    });
    const { ctx } = makeCtx([page]);
    const out = await browserNavigate(
      ctx,
      { url: "https://example.com", timeoutMs: 5000 },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("timeout");
      expect(out.error.timeoutMs).toBe(5000);
    }
  });

  it("default waitUntil is 'load' (Pitfall 3 — NOT networkidle)", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    await browserNavigate(
      ctx,
      { url: "https://example.com" },
      DEFAULT_CFG,
    );
    expect(page.goto).toHaveBeenCalledTimes(1);
    const args = page.goto.mock.calls[0] as [string, { waitUntil: string; timeout: number }];
    expect(args[1].waitUntil).toBe("load");
  });

  it("honors cfg.navigationTimeoutMs when no override provided", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    await browserNavigate(ctx, { url: "https://example.com" }, DEFAULT_CFG);
    const args = page.goto.mock.calls[0] as [string, { waitUntil: string; timeout: number }];
    expect(args[1].timeout).toBe(DEFAULT_CFG.navigationTimeoutMs);
  });

  it("maps non-timeout failure to navigation_failed", async () => {
    const page = makePage();
    page.goto = vi.fn(async () => {
      throw new Error("net::ERR_NAME_NOT_RESOLVED");
    });
    const { ctx } = makeCtx([page]);
    const out = await browserNavigate(
      ctx,
      { url: "https://no-such-host.invalid" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("navigation_failed");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  browserScreenshot                                                  */
/* ------------------------------------------------------------------ */

describe("browserScreenshot", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "tools-screenshot-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("writes PNG to savePath and returns {path, bytes}", async () => {
    const savePath = join(workDir, "shot.png");
    const page = makePage();
    page.screenshot = vi.fn(async () => Buffer.alloc(200, 0xff));
    const { ctx } = makeCtx([page]);
    const out = await browserScreenshot(
      ctx,
      { savePath },
      { ...DEFAULT_CFG, screenshotDir: workDir },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.path).toBe(savePath);
      expect(out.data.bytes).toBe(200);
    }
    const s = await stat(savePath);
    expect(s.size).toBe(200);
  });

  it("returns inlineBase64 when bytes ≤ maxScreenshotInlineBytes", async () => {
    const page = makePage();
    page.screenshot = vi.fn(async () => Buffer.alloc(100, 1));
    const { ctx } = makeCtx([page]);
    const out = await browserScreenshot(
      ctx,
      { savePath: join(workDir, "a.png") },
      { ...DEFAULT_CFG, maxScreenshotInlineBytes: 1024, screenshotDir: workDir },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.inlineBase64).toBeDefined();
    }
  });

  it("omits inlineBase64 when bytes > maxScreenshotInlineBytes (Pitfall 7)", async () => {
    const page = makePage();
    page.screenshot = vi.fn(async () => Buffer.alloc(2048, 1));
    const { ctx } = makeCtx([page]);
    const out = await browserScreenshot(
      ctx,
      { savePath: join(workDir, "b.png") },
      { ...DEFAULT_CFG, maxScreenshotInlineBytes: 1024, screenshotDir: workDir },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.inlineBase64).toBeUndefined();
    }
  });

  it("omits inlineBase64 when maxScreenshotInlineBytes = 0 (sentinel)", async () => {
    const page = makePage();
    page.screenshot = vi.fn(async () => Buffer.alloc(50, 1));
    const { ctx } = makeCtx([page]);
    const out = await browserScreenshot(
      ctx,
      { savePath: join(workDir, "c.png") },
      { ...DEFAULT_CFG, maxScreenshotInlineBytes: 0, screenshotDir: workDir },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.inlineBase64).toBeUndefined();
    }
  });

  it("defaults to <screenshotDir>/browser/screenshots/<date>/<id>.png when no savePath", async () => {
    const page = makePage();
    page.screenshot = vi.fn(async () => Buffer.alloc(32));
    const { ctx } = makeCtx([page]);
    const out = await browserScreenshot(
      ctx,
      {},
      { ...DEFAULT_CFG, screenshotDir: workDir },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.path).toContain(`${workDir}/browser/screenshots/`);
      expect(out.data.path).toMatch(/\.png$/);
    }
  });

  it("forwards fullPage arg to page.screenshot", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    await browserScreenshot(
      ctx,
      { fullPage: true, savePath: join(workDir, "fp.png") },
      { ...DEFAULT_CFG, screenshotDir: workDir },
    );
    expect(page.screenshot).toHaveBeenCalledWith(
      expect.objectContaining({ fullPage: true, type: "png" }),
    );
  });
});

/* ------------------------------------------------------------------ */
/*  browserClick                                                       */
/* ------------------------------------------------------------------ */

describe("browserClick", () => {
  it("returns {clicked: true, selector} on success", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    const out = await browserClick(
      ctx,
      { selector: "#submit" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.clicked).toBe(true);
      expect(out.data.selector).toBe("#submit");
      expect(out.data.newUrl).toBeUndefined();
    }
  });

  it("returns newUrl when URL changed after the click", async () => {
    const page = makePage({ url: "https://a.com" });
    const loc = makeLocator({
      click: vi.fn(async () => {
        page._url = "https://a.com/thanks";
      }),
    });
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserClick(
      ctx,
      { selector: "#submit" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.newUrl).toBe("https://a.com/thanks");
    }
  });

  it("maps TimeoutError to element_not_found with selector and timeoutMs", async () => {
    const page = makePage();
    const loc = makeLocator({
      click: vi.fn(async () => {
        throw makeTimeoutError();
      }),
    });
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserClick(
      ctx,
      { selector: ".missing", timeoutMs: 2500 },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("element_not_found");
      expect(out.error.selector).toBe(".missing");
      expect(out.error.timeoutMs).toBe(2500);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  browserFill                                                        */
/* ------------------------------------------------------------------ */

describe("browserFill", () => {
  it("returns {filled: true, selector} on success", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    const out = await browserFill(
      ctx,
      { selector: "#email", value: "x@example.com" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.filled).toBe(true);
      expect(out.data.selector).toBe("#email");
    }
  });

  it("passes value through to locator.fill", async () => {
    const page = makePage();
    const loc = makeLocator();
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    await browserFill(
      ctx,
      { selector: "#q", value: "hello world" },
      DEFAULT_CFG,
    );
    expect(loc.fill).toHaveBeenCalledWith(
      "hello world",
      expect.objectContaining({ timeout: DEFAULT_CFG.actionTimeoutMs }),
    );
  });

  it("maps TimeoutError to element_not_found", async () => {
    const page = makePage();
    const loc = makeLocator({
      fill: vi.fn(async () => {
        throw makeTimeoutError();
      }),
    });
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserFill(
      ctx,
      { selector: "#missing", value: "x" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("element_not_found");
      expect(out.error.selector).toBe("#missing");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  browserExtract                                                     */
/* ------------------------------------------------------------------ */

describe("browserExtract", () => {
  it("selector mode returns text and html from the locator", async () => {
    const page = makePage();
    const loc = makeLocator({
      textContent: vi.fn(async () => "body text"),
      innerHTML: vi.fn(async () => "<p>body html</p>"),
    });
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserExtract(
      ctx,
      { mode: "selector", selector: "article" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok && out.data.mode === "selector") {
      expect(out.data.text).toBe("body text");
      expect(out.data.html).toBe("<p>body html</p>");
      expect(out.data.selector).toBe("article");
    }
  });

  it("selector mode without selector returns invalid_argument", async () => {
    const { ctx } = makeCtx();
    const out = await browserExtract(ctx, { mode: "selector" }, DEFAULT_CFG);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("invalid_argument");
    }
  });

  it("readability mode returns article fields when parse succeeds", async () => {
    const html = await readFile(join(FIXTURE_DIR, "article.html"), "utf-8");
    const page = makePage({ url: "http://example.com/train", content: html });
    const { ctx } = makeCtx([page]);
    const out = await browserExtract(
      ctx,
      { mode: "readability" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok && out.data.mode === "readability") {
      expect(out.data.title).toBe("How to Train Your Bot");
      expect(out.data.byline).toContain("Clawdy");
      expect(out.data.publishedTime).toBe("2026-04-18T12:00:00Z");
      expect(out.data.text.length).toBeGreaterThan(100);
    }
  });

  it("readability mode returns internal error when parse returns null", async () => {
    const page = makePage({ content: "<html></html>" });
    const { ctx } = makeCtx([page]);
    const out = await browserExtract(
      ctx,
      { mode: "readability" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("internal");
      expect(out.error.message).toContain("Readability");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  browserWaitFor                                                     */
/* ------------------------------------------------------------------ */

describe("browserWaitFor", () => {
  it("matches on selector becoming visible", async () => {
    const page = makePage();
    const loc = makeLocator();
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserWaitFor(
      ctx,
      { selector: "#dynamic" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.matched).toBe(true);
      expect(out.data.elapsedMs).toBeGreaterThanOrEqual(0);
      expect(out.data.elapsedMs).toBeLessThanOrEqual(DEFAULT_CFG.actionTimeoutMs);
    }
  });

  it("matches on URL regex", async () => {
    const page = makePage();
    const { ctx } = makeCtx([page]);
    const out = await browserWaitFor(
      ctx,
      { url: "/thanks" },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(true);
    expect(page.waitForURL).toHaveBeenCalled();
  });

  it("returns {type: 'timeout'} on TimeoutError — does NOT throw (BROWSER-05)", async () => {
    const page = makePage();
    const loc = makeLocator({
      waitFor: vi.fn(async () => {
        throw makeTimeoutError("locator waitFor timeout");
      }),
    });
    page.locator = vi.fn(() => loc);
    const { ctx } = makeCtx([page]);
    const out = await browserWaitFor(
      ctx,
      { selector: "#never", timeoutMs: 300 },
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("timeout");
      expect(out.error.selector).toBe("#never");
      expect(out.error.timeoutMs).toBe(300);
    }
  });

  it("returns invalid_argument when neither selector nor url provided", async () => {
    const { ctx } = makeCtx();
    const out = await browserWaitFor(ctx, {}, DEFAULT_CFG);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("invalid_argument");
    }
  });

  it("returns invalid_argument on malformed URL regex", async () => {
    const { ctx } = makeCtx();
    const out = await browserWaitFor(
      ctx,
      { url: "(" }, // invalid regex
      DEFAULT_CFG,
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.type).toBe("invalid_argument");
    }
  });
});

/* ------------------------------------------------------------------ */
/*  TOOL_DEFINITIONS                                                   */
/* ------------------------------------------------------------------ */

describe("TOOL_DEFINITIONS", () => {
  it("has exactly 6 entries with locked names", () => {
    const names = TOOL_DEFINITIONS.map((d) => d.name);
    expect(names).toEqual([
      "browser_navigate",
      "browser_screenshot",
      "browser_click",
      "browser_fill",
      "browser_extract",
      "browser_wait_for",
    ]);
  });

  it("browser_navigate description warns about networkidle (Pitfall 3)", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "browser_navigate");
    expect(def).toBeDefined();
    expect(def!.description.toLowerCase()).toMatch(/avoid.*networkidle/);
  });

  it("browser_click description steers to getByRole / getByText / getByTestId (Pitfall 4)", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "browser_click");
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/getByRole|getByText|getByTestId/);
  });

  it("browser_fill description steers to getByRole / getByText / getByTestId (Pitfall 4)", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "browser_fill");
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/getByRole|getByText|getByTestId/);
  });

  it("browser_wait_for description steers to getByRole / getByText / getByTestId", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "browser_wait_for");
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/getByRole|getByText|getByTestId/);
  });

  it("browser_screenshot description mentions path-based workflow for repeats (Pitfall 7)", () => {
    const def = TOOL_DEFINITIONS.find((d) => d.name === "browser_screenshot");
    expect(def).toBeDefined();
    expect(def!.description.toLowerCase()).toContain("path");
    expect(def!.description.toLowerCase()).toContain("read");
  });

  it("each entry exposes a schemaBuilder(z) that returns an object shape", async () => {
    const { z } = await import("zod/v4");
    for (const def of TOOL_DEFINITIONS) {
      const shape = def.schemaBuilder(z);
      expect(typeof shape).toBe("object");
      expect(shape).not.toBeNull();
    }
  });
});
