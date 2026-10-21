/**
 * Backlog 999.95 — handleShowPreview unit tests. Covers the core path the
 * operator exercises (previously only reachable through the daemon switch):
 * html/url exactly-one discrimination, id-gen, reserved-id guard, Layer-2
 * validation, previewUrl construction, and the isNew→post / update→no-post branch.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  handleShowPreview,
  type ActivityLauncher,
} from "../show-preview-handler.js";
import { PreviewStore, MAX_PREVIEW_BYTES } from "../../dashboard/preview-store.js";

function fakeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger;
}

function okLauncher(): ActivityLauncher & { calls: number } {
  const launcher = {
    calls: 0,
    postActivityLaunchButton: vi.fn(async () => {
      launcher.calls++;
      return { ok: true as const };
    }),
  };
  return launcher;
}

let store: PreviewStore;
afterEach(() => store?.close());

function deps(overrides: Partial<Parameters<typeof handleShowPreview>[1]> = {}) {
  store = overrides.previewStore ?? new PreviewStore();
  return {
    previewStore: store,
    // "launcher" in overrides distinguishes an explicit null from "not provided"
    // (null ?? okLauncher() would wrongly substitute a real launcher).
    launcher: "launcher" in overrides ? (overrides.launcher ?? null) : okLauncher(),
    activityBaseUrl: overrides.activityBaseUrl ?? "https://activity.example",
    log: overrides.log ?? fakeLog(),
  };
}

describe("handleShowPreview — html / url discrimination", () => {
  it("stores html, builds previewUrl, posts the launch button on first push", async () => {
    const launcher = okLauncher();
    const d = deps({ launcher });
    const r = await handleShowPreview(
      { agent: "a", html: "<p>hi</p>", id: "p1" },
      d,
    );
    expect(r).toEqual({
      ok: true,
      id: "p1",
      isNew: true,
      previewUrl: "https://activity.example/preview/p1",
      posted: true,
      snapshotPosted: false,
    });
    expect(d.previewStore.get("p1")).toEqual({ kind: "html", html: "<p>hi</p>" });
    expect(launcher.calls).toBe(1);
  });

  it("stores a url entry", async () => {
    const d = deps();
    const r = await handleShowPreview(
      { agent: "a", url: "/dashboard/v2/", id: "p2" },
      d,
    );
    expect(r.isNew).toBe(true);
    expect(d.previewStore.get("p2")).toEqual({ kind: "url", url: "/dashboard/v2/" });
  });

  it("rejects when both html and url are present", async () => {
    await expect(
      handleShowPreview({ agent: "a", html: "<p>x</p>", url: "/x" }, deps()),
    ).rejects.toThrow(/exactly one/);
  });

  it("rejects when neither html nor url is present", async () => {
    await expect(handleShowPreview({ agent: "a" }, deps())).rejects.toThrow(
      /exactly one/,
    );
  });
});

describe("handleShowPreview — id handling + validation", () => {
  it("auto-generates a p- id when omitted", async () => {
    const r = await handleShowPreview({ agent: "a", html: "<p>x</p>" }, deps());
    expect(r.id).toMatch(/^p-[A-Za-z0-9_-]{10}$/);
  });

  it("rejects a missing agent", async () => {
    await expect(handleShowPreview({ html: "<p>x</p>" }, deps())).rejects.toThrow(
      /Missing required parameter: agent/,
    );
  });

  it("rejects an invalid id", async () => {
    await expect(
      handleShowPreview({ agent: "a", html: "<p>x</p>", id: "bad/id" }, deps()),
    ).rejects.toThrow(/invalid preview id/);
  });

  it("rejects the reserved id 'current'", async () => {
    await expect(
      handleShowPreview({ agent: "a", html: "<p>x</p>", id: "current" }, deps()),
    ).rejects.toThrow(/reserved/);
  });

  it("rejects oversize html", async () => {
    const big = "x".repeat(MAX_PREVIEW_BYTES + 1);
    await expect(
      handleShowPreview({ agent: "a", html: big, id: "big" }, deps()),
    ).rejects.toThrow(/exceeds/);
  });

  it("rejects an invalid url scheme", async () => {
    await expect(
      handleShowPreview({ agent: "a", url: "javascript:alert(1)", id: "p" }, deps()),
    ).rejects.toThrow(/invalid preview url/);
  });

  it("strips a trailing slash from the activity base url", async () => {
    const r = await handleShowPreview(
      { agent: "a", html: "<p>x</p>", id: "p3" },
      deps({ activityBaseUrl: "https://activity.example/" }),
    );
    expect(r.previewUrl).toBe("https://activity.example/preview/p3");
  });
});

describe("handleShowPreview — launch-post branch (no-relaunch invariant)", () => {
  it("does NOT re-post on an update (same id) — posts only on isNew", async () => {
    const launcher = okLauncher();
    const sharedStore = new PreviewStore();
    const d = deps({ launcher, previewStore: sharedStore });

    const first = await handleShowPreview({ agent: "a", html: "<p>1</p>", id: "p" }, d);
    const second = await handleShowPreview({ agent: "a", html: "<p>2</p>", id: "p" }, d);

    expect(first.isNew).toBe(true);
    expect(first.posted).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.posted).toBe(false);
    expect(launcher.calls).toBe(1); // exactly one post across both pushes
  });

  it("posts false (non-fatal) when no launcher is bound", async () => {
    const r = await handleShowPreview(
      { agent: "a", html: "<p>x</p>", id: "p" },
      deps({ launcher: null }),
    );
    expect(r.posted).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("posts false when the launcher reports ok:false (non-fatal)", async () => {
    const launcher: ActivityLauncher = {
      postActivityLaunchButton: vi.fn(async () => ({ ok: false, reason: "no-voice" })),
    };
    const r = await handleShowPreview(
      { agent: "a", html: "<p>x</p>", id: "p" },
      deps({ launcher }),
    );
    expect(r.posted).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("posts false when the launcher throws (non-fatal)", async () => {
    const launcher: ActivityLauncher = {
      postActivityLaunchButton: vi.fn(async () => {
        throw new Error("discord exploded");
      }),
    };
    const r = await handleShowPreview(
      { agent: "a", html: "<p>x</p>", id: "p" },
      deps({ launcher }),
    );
    expect(r.posted).toBe(false);
    expect(r.ok).toBe(true);
  });
});
