import { describe, it, expect } from "vitest";
import { buildProgressCard, shouldRedraw } from "../card.js";
import type { JobState } from "../progress.js";

const st = (over: Partial<JobState> = {}): JobState => ({
  job: "standup", phase: "transcribing", pct: 43, etaSeconds: 180,
  audioSeconds: 1800, elapsedSeconds: 120, ...over,
});
const text = (c: ReturnType<typeof buildProgressCard>) =>
  c.blocks.filter((b): b is { type: "text"; content: string } => b.type === "text")
    .map((b) => b.content).join("\n");

describe("buildProgressCard", () => {
  it("shows the file name so the owner knows which recording", () => {
    expect(text(buildProgressCard({ state: st(), fileName: "standup.m4a" }))).toContain("standup.m4a");
  });

  it("shows a bar and the percentage", () => {
    const t = text(buildProgressCard({ state: st(), fileName: "a.m4a" }));
    expect(t).toMatch(/[█░]{12}/);
    expect(t).toContain("43%");
  });

  it("shows time remaining while running, not time taken", () => {
    const t = text(buildProgressCard({ state: st(), fileName: "a.m4a" }));
    expect(t).toContain("Left");
    expect(t).not.toContain("Took");
  });

  it("switches to time taken when done", () => {
    const t = text(buildProgressCard({ state: st({ phase: "done", pct: 100, etaSeconds: 0 }), fileName: "a.m4a" }));
    expect(t).toContain("Took");
    expect(t).not.toContain("Left");
    expect(t).toContain("Transcript ready");
  });

  it("omits the ETA entirely when it cannot be known", () => {
    // Better no line than a fabricated number.
    const t = text(buildProgressCard({ state: st({ etaSeconds: undefined }), fileName: "a.m4a" }));
    expect(t).not.toContain("Left");
  });

  it("explains a queued job in the owner's terms", () => {
    const t = text(buildProgressCard({ state: st({ phase: "queued", pct: 1 }), fileName: "a.m4a", queuePosition: 3 }));
    expect(t).toContain("3 jobs ahead");
  });

  it("says 'next up' rather than '1 jobs ahead'", () => {
    const t = text(buildProgressCard({ state: st({ phase: "queued", pct: 1 }), fileName: "a.m4a", queuePosition: 1 }));
    expect(t).toContain("next up");
  });

  it("shows a failure instead of a progress bar, and says a human was told", () => {
    const c = buildProgressCard({ state: st(), fileName: "a.m4a", failureReason: "CUDA OOM" });
    const t = text(c);
    expect(t).toContain("CUDA OOM");
    expect(t).toContain("flagged");
    expect(t).not.toMatch(/[█░]{12}/);
  });

  it("colours by outcome", () => {
    const run = buildProgressCard({ state: st(), fileName: "a" }).accentColor;
    const done = buildProgressCard({ state: st({ phase: "done" }), fileName: "a" }).accentColor;
    const fail = buildProgressCard({ state: st(), fileName: "a", failureReason: "x" }).accentColor;
    expect(new Set([run, done, fail]).size).toBe(3);
  });

  it("produces a spec the renderer accepts (blocks only, no stray keys)", () => {
    for (const b of buildProgressCard({ state: st(), fileName: "a" }).blocks) {
      expect(["text", "separator"]).toContain(b.type);
    }
  });
});

describe("shouldRedraw", () => {
  it("draws the first time", () => {
    expect(shouldRedraw(undefined, st())).toBe(true);
  });
  it("redraws when the percentage moves", () => {
    expect(shouldRedraw(st({ pct: 43 }), st({ pct: 44 }))).toBe(true);
  });
  it("redraws on a phase change", () => {
    expect(shouldRedraw(st({ phase: "transcribing" }), st({ phase: "diarizing" }))).toBe(true);
  });
  it("does NOT redraw when nothing visible changed — rate limit is finite", () => {
    expect(shouldRedraw(st({ pct: 43, etaSeconds: 180 }), st({ pct: 43, etaSeconds: 179 }))).toBe(false);
  });
});
