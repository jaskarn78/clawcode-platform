import { describe, it, expect, vi, afterEach } from "vitest";
import { BurstGatherer, shouldLeadBurst } from "../burst-gatherer.js";
import { PendingImageLedger } from "../pending-image-ledger.js";
import { formatDiscordMessage, turnImageSourcesFrom } from "../bridge.js";
import type { DownloadResult } from "../attachment-types.js";

afterEach(() => {
  vi.useRealTimers();
});

const timing = { quietMs: 1500, maxWaitMs: 5000 };
const s = (n: number) => ({ path: `/inbox/${n}.jpg`, filename: `${n}.jpg`, mimeType: "image/jpeg" });

describe("shouldLeadBurst", () => {
  it("leads on the 10-attachment ceiling or images without text", () => {
    expect(shouldLeadBurst({ attachmentCount: 10, imageCount: 10, text: "look" })).toBe(true);
    expect(shouldLeadBurst({ attachmentCount: 2, imageCount: 2, text: "" })).toBe(true);
    expect(shouldLeadBurst({ attachmentCount: 2, imageCount: 2, text: "what's this?" })).toBe(false);
    expect(shouldLeadBurst({ attachmentCount: 1, imageCount: 0, text: "" })).toBe(false);
  });
});

describe("BurstGatherer", () => {
  it("a lone leader resolves after the quiet window with no members", async () => {
    vi.useFakeTimers();
    const g = new BurstGatherer(() => Date.now());
    const leader = g.open("c:u", "m1", timing);
    let done = false;
    void leader.wait().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1400);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
  });

  it("members that announce before close are folded in, in arrival order, once the leader commits", async () => {
    vi.useFakeTimers();
    const g = new BurstGatherer(() => Date.now());
    const leader = g.open("c:u", "m1", timing);
    const m2 = g.announce("c:u", "m2")!;
    const m3 = g.announce("c:u", "m3")!;
    // m2 is still downloading well past the quiet window — the leader waits.
    await vi.advanceTimersByTimeAsync(3000);
    const t3 = m3.contribute({ text: "third", sources: [s(3)] });
    await vi.advanceTimersByTimeAsync(3000);
    const t2 = m2.contribute({ text: "second", sources: [s(2)] });
    await vi.advanceTimersByTimeAsync(1600);
    const members = await leader.wait();
    expect(members.map((m) => m.messageId)).toEqual(["m3", "m2"]);
    expect(g.isOpen("c:u")).toBe(false);
    leader.commit();
    expect(await t3).toBe(true);
    expect(await t2).toBe(true);
  });

  it("a member that misses the window must dispatch itself (never dropped)", async () => {
    vi.useFakeTimers();
    const g = new BurstGatherer(() => Date.now());
    const leader = g.open("c:u", "m1", timing);
    const late = g.announce("c:u", "m2")!;
    await vi.advanceTimersByTimeAsync(15_001); // hard ceiling = 3 × maxWaitMs
    await leader.wait();
    expect(await late.contribute({ text: "late", sources: [] })).toBe(false);
    expect(g.announce("c:u", "m3")).toBeNull();
  });

  it("a failed leader releases members to dispatch themselves (review fix)", async () => {
    vi.useFakeTimers();
    const g = new BurstGatherer(() => Date.now());
    const leader = g.open("c:u", "m1", timing);
    const member = g.announce("c:u", "m2")!;
    const taken = member.contribute({ text: "second", sources: [s(2)] });
    leader.abort(); // leader threw before/after wait()
    expect(await taken).toBe(false);
    expect(g.isOpen("c:u")).toBe(false);
  });

  it("watchdog releases members if a closed leader never commits or aborts", async () => {
    vi.useFakeTimers();
    const g = new BurstGatherer(() => Date.now());
    const leader = g.open("c:u", "m1", timing);
    const taken = g.announce("c:u", "m2")!.contribute({ text: "x", sources: [] });
    await vi.advanceTimersByTimeAsync(2000);
    await leader.wait();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(await taken).toBe(false);
  });

  it("other authors / channels never join", () => {
    const g = new BurstGatherer();
    g.open("c:u", "m1", timing);
    expect(g.announce("c:other", "m2")).toBeNull();
  });
});

describe("PendingImageLedger", () => {
  it("add/get/release, merge for combined dispatch, TTL eviction", () => {
    let t = 0;
    const l = new PendingImageLedger(1000, () => t);
    l.add("a", "m1", [s(1)]);
    l.add("a", "m2", [s(2)]);
    l.add("a", "m3", [s(3)]);
    l.mergeInto("a", "m1", ["m2", "m3"]);
    expect(l.get("a", "m1").map((x) => x.path)).toEqual(["/inbox/1.jpg", "/inbox/2.jpg", "/inbox/3.jpg"]);
    expect(l.get("a", "m2")).toEqual([]);
    l.release("a", "m1");
    expect(l.size()).toBe(0);
    l.add("a", "m9", [s(9)]);
    t = 2000;
    expect(l.get("a", "m9")).toEqual([]);
  });
});

describe("formatDiscordMessage inline mode + turnImageSourcesFrom", () => {
  const results: DownloadResult[] = [
    {
      success: true,
      path: "/inbox/1-a.png",
      error: null,
      attachmentInfo: { name: "a.png", url: "u", contentType: "image/png", size: 10, proxyUrl: "p" },
    } as unknown as DownloadResult,
    {
      success: true,
      path: "/inbox/2-b.pdf",
      error: null,
      attachmentInfo: { name: "b.pdf", url: "u", contentType: "application/pdf", size: 10, proxyUrl: "p" },
    } as unknown as DownloadResult,
  ];
  const message = {
    channelId: "c",
    id: "m1",
    author: { username: "client-a-user" },
    content: "",
    createdAt: new Date("2026-09-22T00:00:00Z"),
    attachments: new Map(),
  } as never;

  it("omits per-image hints (the dispatch-time manifest supersedes them)", () => {
    const out = formatDiscordMessage(message, results, undefined, "UTC", new Map(), { inlineImages: true });
    expect(out).toContain('local_path="/inbox/1-a.png"');
    expect(out).not.toContain("Image downloaded");
    expect(out).not.toContain("<screenshot-analysis>");
  });

  it("legacy mode keeps the path hint", () => {
    const out = formatDiscordMessage(message, results, undefined, "UTC", new Map());
    expect(out).toContain("Image downloaded -- read the file at /inbox/1-a.png");
  });

  it("only successfully downloaded images become turn images", () => {
    expect(turnImageSourcesFrom(results)).toEqual([
      { path: "/inbox/1-a.png", filename: "a.png", mimeType: "image/png" },
    ]);
  });
});
