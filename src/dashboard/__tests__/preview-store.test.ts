/**
 * Backlog 999.95 — PreviewStore unit tests + dashboard /preview route tests.
 *
 * The route tests inject a real PreviewStore into the real dashboard server
 * (the injectable-config seam) and drive the routes over HTTP on an ephemeral
 * port — the genuine integration check without spinning up a full daemon.
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import type { ServerResponse } from "node:http";
import {
  PreviewStore,
  renderPreviewDocument,
  isValidPreviewUrl,
  MAX_PREVIEW_BYTES,
  MAX_PREVIEWS,
} from "../preview-store.js";
import { startDashboardServer } from "../server.js";

/** Minimal ServerResponse stand-in capturing writes + a manual close trigger. */
function fakeRes() {
  const writes: string[] = [];
  let closeHandler: (() => void) | undefined;
  let ended = false;
  const res = {
    writeHead: () => res,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    end: () => {
      ended = true;
    },
    on: (event: string, handler: () => void) => {
      if (event === "close") closeHandler = handler;
      return res;
    },
  };
  return {
    res: res as unknown as ServerResponse,
    writes,
    isEnded: () => ended,
    triggerClose: () => closeHandler?.(),
  };
}

describe("PreviewStore — storage + isNew", () => {
  let store: PreviewStore;
  afterEach(() => store?.close());

  it("stores html and reports isNew on first push, false on update", () => {
    store = new PreviewStore();
    const r1 = store.set("abc", { kind: "html", html: "<p>hi</p>" });
    expect(r1).toEqual({ isNew: true, id: "abc" });
    expect(store.get("abc")).toEqual({ kind: "html", html: "<p>hi</p>" });

    const r2 = store.set("abc", { kind: "html", html: "<p>bye</p>" });
    expect(r2.isNew).toBe(false);
    expect(store.get("abc")).toEqual({ kind: "html", html: "<p>bye</p>" });
  });

  it("returns null for an unknown id", () => {
    store = new PreviewStore();
    expect(store.get("nope")).toBeNull();
  });
});

describe("PreviewStore — id validation + size cap", () => {
  let store: PreviewStore;
  afterEach(() => store?.close());

  it("accepts safe ids and rejects traversal / oversize / empty", () => {
    expect(PreviewStore.isValidId("ok_id-1")).toBe(true);
    expect(PreviewStore.isValidId("../etc")).toBe(false);
    expect(PreviewStore.isValidId("a/b")).toBe(false);
    expect(PreviewStore.isValidId("")).toBe(false);
    expect(PreviewStore.isValidId("a".repeat(65))).toBe(false);
  });

  it("set() throws on invalid id", () => {
    store = new PreviewStore();
    expect(() => store.set("bad/id", { kind: "html", html: "x" })).toThrow(
      /invalid preview id/,
    );
  });

  it("set() throws when html exceeds the byte cap", () => {
    store = new PreviewStore();
    const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
    expect(() => store.set("big", { kind: "html", html: big })).toThrow(/exceeds/);
  });
});

describe("PreviewStore — LRU eviction", () => {
  let store: PreviewStore;
  afterEach(() => store?.close());

  it("evicts the oldest preview past MAX_PREVIEWS and closes its listeners", () => {
    store = new PreviewStore();
    const evicted = fakeRes();
    store.addListener("id0", evicted.res);

    for (let i = 0; i < MAX_PREVIEWS + 1; i++) {
      store.set(`id${i}`, { kind: "html", html: `<p>${i}</p>` });
    }

    // id0 was the oldest → evicted; its listener got end()'d.
    expect(store.get("id0")).toBeNull();
    expect(evicted.isEnded()).toBe(true);
    // The most recent is still present.
    expect(store.get(`id${MAX_PREVIEWS}`)).not.toBeNull();
  });
});

describe("PreviewStore — currentId time-box", () => {
  let store: PreviewStore;
  afterEach(() => store?.close());

  it("returns null when empty", () => {
    store = new PreviewStore();
    expect(store.currentId("chan-1")).toBeNull();
  });

  // 999.95-fu3 — last-writer-wins is now PER CHANNEL. Previously one global
  // pointer meant the last push from ANY agent became every channel's
  // `current`, so one channel's preview surfaced in another's Activity.
  it("resolves the most-recent push per channel, but null past the window", () => {
    let t = 1000;
    store = new PreviewStore({ now: () => t });
    store.set("a", { kind: "html", html: "a" }, "chan-1");
    store.set("b", { kind: "html", html: "b" }, "chan-1");
    expect(store.currentId("chan-1")).toBe("b"); // fresh + last writer

    t += 130_000; // > default 120s window
    expect(store.currentId("chan-1")).toBeNull();

    // A custom (longer) window still resolves it.
    expect(store.currentId("chan-1", 200_000)).toBe("b");
  });

  it("last-writer-wins does NOT cross channels", () => {
    store = new PreviewStore();
    store.set("a", { kind: "html", html: "a" }, "chan-1");
    store.set("b", { kind: "html", html: "b" }, "chan-2");
    expect(store.currentId("chan-1")).toBe("a");
    expect(store.currentId("chan-2")).toBe("b");
  });
});

describe("PreviewStore — SSE registry mechanics", () => {
  let store: PreviewStore;
  afterEach(() => store?.close());

  it("writes headers + keepalive on addListener and fires reload on set", () => {
    store = new PreviewStore();
    const client = fakeRes();
    store.addListener("s1", client.res);
    expect(client.writes.some((w) => w.includes(":keepalive"))).toBe(true);

    store.set("s1", { kind: "html", html: "a" });
    expect(client.writes.some((w) => w.startsWith("event: reload"))).toBe(true);
  });

  it("drops a listener on close so later reloads do not write to it", () => {
    store = new PreviewStore();
    const client = fakeRes();
    store.addListener("s2", client.res);
    store.set("s2", { kind: "html", html: "a" });
    const reloadsBefore = client.writes.filter((w) => w.startsWith("event: reload")).length;

    client.triggerClose();
    store.set("s2", { kind: "html", html: "b" }); // listener gone → no write
    const reloadsAfter = client.writes.filter((w) => w.startsWith("event: reload")).length;
    expect(reloadsAfter).toBe(reloadsBefore);
  });
});

describe("renderPreviewDocument", () => {
  it("injects an ABSOLUTE SSE path before </body> for html previews", () => {
    const doc = renderPreviewDocument(
      { kind: "html", html: "<html><body><h1>x</h1></body></html>" },
      "myid",
    );
    expect(doc).toContain('new EventSource("/preview/myid/events")');
    expect(doc.indexOf("EventSource")).toBeLessThan(doc.indexOf("</body>"));
  });

  it("appends the reloader when there is no </body>", () => {
    const doc = renderPreviewDocument({ kind: "html", html: "<h1>x</h1>" }, "id2");
    expect(doc).toContain("<h1>x</h1>");
    expect(doc).toContain('new EventSource("/preview/id2/events")');
  });

  it("frames the url and injects the reloader for url previews", () => {
    const doc = renderPreviewDocument({ kind: "url", url: "/dashboard/v2/" }, "id3");
    expect(doc).toContain('<iframe src="/dashboard/v2/"');
    expect(doc).toContain('new EventSource("/preview/id3/events")');
  });

  it("escapes the url to neutralize attribute-injection", () => {
    const doc = renderPreviewDocument(
      { kind: "url", url: '/x"><script>alert(1)</script>' },
      "id4",
    );
    expect(doc).not.toContain('"><script>alert(1)');
    expect(doc).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("isValidPreviewUrl", () => {
  it("accepts same-origin paths and http(s) absolute URLs", () => {
    expect(isValidPreviewUrl("/dashboard/v2/")).toBe(true);
    expect(isValidPreviewUrl("https://grafana.tail/")).toBe(true);
    expect(isValidPreviewUrl("http://x/")).toBe(true);
  });

  it("rejects protocol-relative, dangerous schemes, empty, and oversize", () => {
    expect(isValidPreviewUrl("//evil.com")).toBe(false);
    expect(isValidPreviewUrl("javascript:alert(1)")).toBe(false);
    expect(isValidPreviewUrl("data:text/html,x")).toBe(false);
    expect(isValidPreviewUrl("ftp://x/")).toBe(false);
    expect(isValidPreviewUrl("")).toBe(false);
    expect(isValidPreviewUrl("/" + "x".repeat(2049))).toBe(false);
  });
});

describe("dashboard /preview routes (injected PreviewStore)", () => {
  let handle: Awaited<ReturnType<typeof startDashboardServer>>;
  let store: PreviewStore;
  let base: string;

  beforeAll(async () => {
    store = new PreviewStore();
    handle = await startDashboardServer({
      port: 0, // OS-assigned ephemeral port
      host: "127.0.0.1",
      socketPath: "/tmp/clawcode-preview-test.sock", // no daemon — polls fail-safe
      pollIntervalMs: 3_600_000, // never fires during the test
      previewStore: store,
    });
    const addr = handle.server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await handle.close();
    store.close();
  });

  it("GET /preview/current → {id:null} before any push", async () => {
    const r = await fetch(`${base}/preview/current`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ id: null });
  });

  it("GET /preview/:id → 404 before push, 200 HTML with absolute SSE path after", async () => {
    const missing = await fetch(`${base}/preview/rt1`);
    expect(missing.status).toBe(404);

    store.set("rt1", { kind: "html", html: "<html><body>hello</body></html>" });
    const r = await fetch(`${base}/preview/rt1`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/html");
    const body = await r.text();
    expect(body).toContain("hello");
    expect(body).toContain('new EventSource("/preview/rt1/events")');
  });

  // 999.95-fu3 — `current` is channel-scoped. The route reads `?channel=`,
  // which the live Activity client has been sending all along.
  it("GET /preview/current?channel= → the fresh id for THAT channel", async () => {
    store.set("rt2", { kind: "html", html: "<p>2</p>" }, "chan-1");
    const r = await fetch(`${base}/preview/current?channel=chan-1`);
    expect(await r.json()).toEqual({ id: "rt2" });
  });

  it("GET /preview/current?channel= → null for a different channel", async () => {
    const r = await fetch(`${base}/preview/current?channel=chan-other`);
    expect(await r.json()).toEqual({ id: null });
  });

  it("GET /preview/current with NO channel → null (fails closed)", async () => {
    // The Activity client falls back to an unscoped call when the scoped one
    // yields nothing. If that returned the global most-recent it would
    // re-open the cross-channel leak this scoping exists to close.
    const r = await fetch(`${base}/preview/current`);
    expect(await r.json()).toEqual({ id: null });
  });

  it("GET /preview/:id → 400 on an invalid id", async () => {
    const r = await fetch(`${base}/preview/bad.id`);
    expect(r.status).toBe(400);
  });

  it("GET /preview/:id/events → 200 text/event-stream", async () => {
    const ac = new AbortController();
    const r = await fetch(`${base}/preview/rt1/events`, { signal: ac.signal });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("text/event-stream");
    ac.abort(); // close the SSE connection so the test can finish
  });
});
