/**
 * 999.95-fu — inline preview snapshots: renderer fail-soft contract + arg
 * construction, and the handler's snapshot flow (post on new, deliver on
 * reuse, never breaks the push).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  renderPreviewSnapshot,
  _resetBinaryCache,
} from "../preview-snapshot.js";
import { handleShowPreview, type PreviewSnapshotter } from "../show-preview-handler.js";
import { PreviewStore } from "../../dashboard/preview-store.js";

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
} as never;

beforeEach(() => {
  _resetBinaryCache();
  vi.clearAllMocks();
});

describe("renderPreviewSnapshot — fail-soft contract", () => {
  it("returns null when no headless binary exists (and never throws)", async () => {
    const png = await renderPreviewSnapshot({ kind: "html", html: "<p>x</p>" }, log, {
      binary: null,
    });
    expect(png).toBeNull();
  });

  it("builds the exact chromium arg shape validated on prod", async () => {
    let captured: readonly string[] = [];
    const exec = vi.fn(async (_bin: string, args: readonly string[]) => {
      captured = args;
      // Simulate chromium writing the screenshot.
      const { writeFile } = await import("node:fs/promises");
      const out = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
      await writeFile(out, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return { stdout: "", stderr: "" };
    });
    const png = await renderPreviewSnapshot({ kind: "html", html: "<p>hi</p>" }, log, {
      exec: exec as never,
      binary: "/fake/headless_shell",
    });
    expect(png).not.toBeNull();
    expect(captured).toContain("--headless");
    expect(captured).toContain("--no-sandbox");
    expect(captured).toContain("--force-device-scale-factor=2");
    expect(captured).toContain("--window-size=390,1400");
    // html inputs load via a temp file:// target
    expect(captured.some((a) => a.startsWith("file://"))).toBe(true);
  });

  it("url inputs pass the url straight through as the target", async () => {
    let captured: readonly string[] = [];
    const exec = vi.fn(async (_bin: string, args: readonly string[]) => {
      captured = args;
      const { writeFile } = await import("node:fs/promises");
      const out = args.find((a) => a.startsWith("--screenshot="))!.slice("--screenshot=".length);
      await writeFile(out, Buffer.from([1, 2, 3]));
      return { stdout: "", stderr: "" };
    });
    await renderPreviewSnapshot({ kind: "url", url: "https://activity.example/preview/x" }, log, {
      exec: exec as never,
      binary: "/fake/headless_shell",
    });
    expect(captured.at(-1)).toBe("https://activity.example/preview/x");
  });

  it("a throwing exec (timeout/crash) yields null, not an exception", async () => {
    const exec = vi.fn(async () => {
      throw new Error("timed out");
    });
    const png = await renderPreviewSnapshot({ kind: "html", html: "<p></p>" }, log, {
      exec: exec as never,
      binary: "/fake/headless_shell",
    });
    expect(png).toBeNull();
  });
});

describe("handleShowPreview — snapshot flow (999.95-fu)", () => {
  function deps(overrides: Partial<Parameters<typeof handleShowPreview>[1]> = {}) {
    return {
      previewStore: new PreviewStore(),
      launcher: { postActivityLaunchButton: vi.fn(async () => ({ ok: true })) },
      activityBaseUrl: "https://activity.example",
      log,
      ...overrides,
    } as Parameters<typeof handleShowPreview>[1];
  }

  const HTML = "<!doctype html><p>hello</p>";

  // ── 999.95-fu2 — the Activity launch rides on the snapshot ──────────────
  //
  // The 2026-09-02 rework made the launch affordance fire only when the
  // snapshot FAILED. Because the motion tier lands reliably it stopped
  // appearing at all, and the live interactive preview went with it. The
  // objection then was to a SECOND MESSAGE carrying a link, not to the
  // Activity — so the launch now hangs off the snapshot itself.

  it("attaches the Activity invite as the FIRST link button on the snapshot", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const launcher = {
      postActivityLaunchButton: vi.fn(async () => ({ ok: true })),
      createActivityInviteUrl: vi.fn(async () => "https://discord.gg/abc123"),
    };
    await handleShowPreview(
      { agent: "shopping", html: HTML, id: "act1" },
      deps({ snapshot, launcher } as never),
    );
    expect(snapshot.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        links: [{ label: "🪟 Open Live Preview", url: "https://discord.gg/abc123" }],
      }),
    );
    // Still ONE message — no separate launch post alongside the snapshot.
    expect(launcher.postActivityLaunchButton).not.toHaveBeenCalled();
  });

  it("keeps the Activity button ahead of agent links and honours the 5-button cap", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const launcher = {
      postActivityLaunchButton: vi.fn(async () => ({ ok: true })),
      createActivityInviteUrl: vi.fn(async () => "https://discord.gg/abc123"),
    };
    await handleShowPreview(
      {
        agent: "shopping",
        html: HTML,
        id: "act2",
        links: [1, 2, 3, 4, 5].map((n) => ({
          label: `L${n}`,
          url: `https://example.com/${n}`,
        })),
      },
      deps({ snapshot, launcher } as never),
    );
    const delivered = (snapshot.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(delivered.links).toHaveLength(5);
    expect(delivered.links[0].url).toBe("https://discord.gg/abc123");
  });

  it("posts the snapshot unchanged when no invite can be minted", async () => {
    // No voice channel resolves (the common case while
    // DISCORD_ACTIVITY_VOICE_CHANNEL_ID is unset) — the snapshot must still go.
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const launcher = {
      postActivityLaunchButton: vi.fn(async () => ({ ok: true })),
      createActivityInviteUrl: vi.fn(async () => undefined),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: HTML, id: "act3" },
      deps({ snapshot, launcher } as never),
    );
    expect(r.snapshotPosted).toBe(true);
    const delivered = (snapshot.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(delivered.links).toBeUndefined();
  });

  it("a throwing invite never costs the snapshot", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const launcher = {
      postActivityLaunchButton: vi.fn(async () => ({ ok: true })),
      createActivityInviteUrl: vi.fn(async () => {
        throw new Error("discord 403");
      }),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: HTML, id: "act4" },
      deps({ snapshot, launcher } as never),
    );
    expect(r.snapshotPosted).toBe(true);
  });

  it("an older bridge with no createActivityInviteUrl still works", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: HTML, id: "act5" },
      deps({ snapshot }),
    );
    expect(r.snapshotPosted).toBe(true);
  });

  it("renders + delivers on a NEW push and reports snapshotPosted", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: HTML, id: "demo1" },
      deps({ snapshot }),
    );
    expect(r.snapshotPosted).toBe(true);
    expect(snapshot.render).toHaveBeenCalledWith({ kind: "html", html: HTML });
    expect(snapshot.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "shopping", previewId: "demo1", filename: "preview-demo1.png" }),
    );
    // Operator feedback 2026-09-02: NO activity links anywhere.
    const caption = (snapshot.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0].caption;
    expect(caption).not.toContain("https://activity.example");
  });

  it("snapshot delivery SUPPRESSES the launch affordance (no activity links)", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const d = deps({ snapshot });
    const r = await handleShowPreview({ agent: "shopping", html: HTML, id: "demoL" }, d);
    expect(r.snapshotPosted).toBe(true);
    expect(r.posted).toBe(false);
    expect(d.launcher!.postActivityLaunchButton).not.toHaveBeenCalled();
  });

  it("delivers on REUSE too (hot-reload updates the image in place)", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const d = deps({ snapshot });
    await handleShowPreview({ agent: "shopping", html: HTML, id: "demo2" }, d);
    const r2 = await handleShowPreview({ agent: "shopping", html: HTML + "!", id: "demo2" }, d);
    expect(r2.isNew).toBe(false);
    expect(r2.snapshotPosted).toBe(true);
    expect(snapshot.deliver).toHaveBeenCalledTimes(2);
  });

  it("render returning null is fail-soft: push succeeds, snapshotPosted=false", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => null),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const d3 = deps({ snapshot });
    const r = await handleShowPreview({ agent: "shopping", html: HTML, id: "demo3" }, d3);
    expect(r.ok).toBe(true);
    expect(r.snapshotPosted).toBe(false);
    expect(snapshot.deliver).not.toHaveBeenCalled();
    // No snapshot landed → the launch affordance is the fallback.
    expect(d3.launcher!.postActivityLaunchButton).toHaveBeenCalled();
  });

  it("a THROWING snapshotter never breaks the preview push", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => {
        throw new Error("chromium exploded");
      }),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: HTML, id: "demo4" },
      deps({ snapshot }),
    );
    expect(r.ok).toBe(true);
    expect(r.snapshotPosted).toBe(false);
  });

  it("no snapshotter (null/omitted) = exact pre-fu behavior", async () => {
    const r = await handleShowPreview({ agent: "shopping", html: HTML }, deps());
    expect(r.ok).toBe(true);
    expect(r.snapshotPosted).toBe(false);
  });

  it("relative url previews are absolutized against the activity base for rendering", async () => {
    const snapshot: PreviewSnapshotter = {
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    await handleShowPreview(
      { agent: "shopping", url: "/dashboard/v2", id: "demo5" },
      deps({ snapshot }),
    );
    expect(snapshot.render).toHaveBeenCalledWith({
      kind: "url",
      url: "https://activity.example/dashboard/v2",
    });
  });
});

describe("handleShowPreview — motion tier (999.95-fu2)", () => {
  function deps2(snapshot: PreviewSnapshotter) {
    return {
      previewStore: new PreviewStore(),
      launcher: { postActivityLaunchButton: vi.fn(async () => ({ ok: true })) },
      activityBaseUrl: "https://activity.example",
      log,
      snapshot,
    } as Parameters<typeof handleShowPreview>[1];
  }

  it("motion wins over PNG and delivers an mp4 filename + 🎬 caption", async () => {
    const snapshot: PreviewSnapshotter = {
      renderMotion: vi.fn(async () => ({ buffer: Buffer.from("vid"), filename: "preview.mp4" })),
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: "<p>x</p>", id: "m1" },
      deps2(snapshot),
    );
    expect(r.snapshotPosted).toBe(true);
    expect(snapshot.render).not.toHaveBeenCalled(); // motion short-circuits PNG
    const call = (snapshot.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.filename).toBe("preview-m1.mp4");
    expect(call.caption).toContain("🎬");
  });

  it("motion null → falls back to PNG (📸)", async () => {
    const snapshot: PreviewSnapshotter = {
      renderMotion: vi.fn(async () => null),
      render: vi.fn(async () => Buffer.from("png")),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: "<p>x</p>", id: "m2" },
      deps2(snapshot),
    );
    expect(r.snapshotPosted).toBe(true);
    const call = (snapshot.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.filename).toBe("preview-m2.png");
    expect(call.caption).toContain("📸");
  });

  it("motion AND png both null → no delivery, push still ok", async () => {
    const snapshot: PreviewSnapshotter = {
      renderMotion: vi.fn(async () => null),
      render: vi.fn(async () => null),
      deliver: vi.fn(async () => ({ ok: true })),
    };
    const r = await handleShowPreview(
      { agent: "shopping", html: "<p>x</p>", id: "m3" },
      deps2(snapshot),
    );
    expect(r.ok).toBe(true);
    expect(r.snapshotPosted).toBe(false);
    expect(snapshot.deliver).not.toHaveBeenCalled();
  });
});

describe("caption + link buttons (operator UX, 2026-09-02)", () => {
  function d2(snapshot: PreviewSnapshotter) {
    return {
      previewStore: new PreviewStore(),
      launcher: { postActivityLaunchButton: vi.fn(async () => ({ ok: true })) },
      activityBaseUrl: "https://activity.example",
      log,
      snapshot,
    } as Parameters<typeof handleShowPreview>[1];
  }
  const mk = (): PreviewSnapshotter => ({
    render: vi.fn(async () => Buffer.from("png")),
    deliver: vi.fn(async () => ({ ok: true })),
  });

  it("an agent-supplied caption becomes the message text", async () => {
    const s = mk();
    await handleShowPreview(
      { agent: "shopping", html: "<p>x</p>", id: "c1", caption: "**$181.99** — in stock nearby." },
      d2(s),
    );
    const call = (s.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.caption).toBe("**$181.99** — in stock nearby.");
  });

  it("falls back to the default caption when none is given", async () => {
    const s = mk();
    await handleShowPreview({ agent: "shopping", html: "<p>x</p>", id: "c2" }, d2(s));
    expect((s.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0].caption).toContain("shopping");
  });

  it("keeps https links and drops javascript:/http:/malformed ones", async () => {
    const s = mk();
    await handleShowPreview(
      {
        agent: "shopping", html: "<p>x</p>", id: "c3",
        links: [
          { label: "Buy at AutoZone — $181.99", url: "https://www.autozone.com/p/x" },
          { label: "evil", url: "javascript:alert(1)" },
          { label: "insecure", url: "http://example.com" },
          { label: "junk", url: "not-a-url" },
          { label: "", url: "https://example.com/nolabel" },
        ],
      },
      d2(s),
    );
    const links = (s.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0].links;
    expect(links).toEqual([{ label: "Buy at AutoZone — $181.99", url: "https://www.autozone.com/p/x" }]);
  });

  it("caps at 5 buttons", async () => {
    const s = mk();
    await handleShowPreview(
      {
        agent: "shopping", html: "<p>x</p>", id: "c4",
        links: Array.from({ length: 9 }, (_, i) => ({ label: `s${i}`, url: `https://e.example/${i}` })),
      },
      d2(s),
    );
    expect((s.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0].links).toHaveLength(5);
  });

  it("omits links entirely when none survive sanitizing", async () => {
    const s = mk();
    await handleShowPreview(
      { agent: "shopping", html: "<p>x</p>", id: "c5", links: [{ label: "x", url: "ftp://n.example" }] },
      d2(s),
    );
    expect((s.deliver as ReturnType<typeof vi.fn>).mock.calls[0][0].links).toBeUndefined();
  });
});
