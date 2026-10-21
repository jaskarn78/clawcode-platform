/**
 * Phase 999.188 — dream auto-promote: veto store approve, snapshotting
 * applier, promote primitive, veto tick, machinery routing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { createDreamVetoStore, type VetoStoreRow } from "../dream-veto-store.js";
import { applyDreamResultD10 } from "../dream-auto-apply.js";
import { promoteCandidates, formatPromoteReport } from "../dream-promote.js";
import { registerDreamVetoTick } from "../dream-veto-tick.js";
import { buildDreamMachinery, resolveDreamPolicy } from "../dream-machinery.js";
import type { DreamPassOutcome, DreamResult } from "../dream-pass.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
const pino = { info() {}, warn() {}, error() {}, debug() {}, child() { return pino; } } as unknown as Logger;
const NOW = new Date("2026-09-30T10:00:00.000Z");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "dream-promote-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

function completed(candidates: DreamResult["promotionCandidates"]): DreamPassOutcome {
  return {
    kind: "completed",
    result: { newWikilinks: [], promotionCandidates: candidates, themedReflection: "r", suggestedConsolidations: [] },
    durationMs: 1,
    tokensIn: 1,
    tokensOut: 1,
    model: "haiku",
  };
}

describe("VetoStore.approveRun (999.188)", () => {
  it("moves a pending row's deadline into the past so the next tick applies it", async () => {
    const store = createDreamVetoStore(tmp);
    await store.scheduleAutoApply({ runId: "r1", agentName: "a", candidates: [], deadline: NOW.getTime() + 1_800_000, isPriorityPass: false });
    expect(await store.tick(NOW, async () => ({ ok: true }))).toEqual([]);
    expect(await store.approveRun!("r1")).toBe(true);
    expect(await store.tick(NOW, async () => ({ ok: true }))).toEqual(["r1"]);
    expect(await store.approveRun!("r1")).toBe(false); // no longer pending
  });
});

describe("applyDreamResultD10 snapshots + knobs (999.188)", () => {
  it("stores the chunk text on the row, honours a custom floor/window, and writes the dream log", async () => {
    const store = createDreamVetoStore(tmp);
    const writeDreamLog = vi.fn(async () => ({ logPath: "/dreams/x.md", appended: true }));
    const out = await applyDreamResultD10({
      agentName: "a",
      outcome: completed([
        { chunkId: "c1", currentPath: "memory/2026-09-01.md", rationale: "", priorityScore: 60 },
        { chunkId: "c2", currentPath: "memory/2026-09-02.md", rationale: "", priorityScore: 40 },
      ]),
      isPriorityPass: false,
      memoryRoot: tmp,
      log: noopLog,
      vetoStore: store,
      nanoid: () => "run-x",
      applyAutoLinks: async () => ({ added: 0 }),
      now: () => NOW,
      resolveChunk: (id) => (id === "c1" ? { heading: "Deploy rule", body: "never deploy without a go" } : null),
      writeDreamLog,
      autoApplyFloor: 50,
      vetoWindowMs: 5 * 60_000,
    });
    expect(out).toMatchObject({ kind: "applied", runId: "run-x", autoApplyScheduled: 1, operatorRequiredCount: 1, logPath: "/dreams/x.md" });
    const rows = await store.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deadline).toBe(NOW.getTime() + 5 * 60_000);
    expect(rows[0]!.candidates[0]).toMatchObject({ chunkId: "c1", heading: "Deploy rule", body: "never deploy without a go" });
    expect(writeDreamLog).toHaveBeenCalledTimes(1);
  });
});

describe("promoteCandidates (999.188)", () => {
  const row = (candidates: VetoStoreRow["candidates"]): VetoStoreRow => ({
    runId: "run-abc12345",
    agentName: "a",
    candidates,
    deadline: 0,
    isPriorityPass: false,
    status: "pending",
    scheduledAt: NOW.toISOString(),
  });
  function fakeMemory(initial = "# MEMORY\n") {
    let text = initial;
    return {
      text: () => text,
      readMemory: async () => text,
      appendMemory: async (content: string) => {
        text += content;
        return { ok: true };
      },
    };
  }

  it("appends the live chunk under its heading with a provenance line", async () => {
    const mem = fakeMemory();
    const res = await promoteCandidates(row([{ chunkId: "c1", currentPath: "memory/2026-09-01.md", rationale: "", priorityScore: 90 }]), {
      resolveChunk: () => ({ heading: "Deploy rule", body: "never deploy without a go" }),
      readMemory: mem.readMemory,
      appendMemory: mem.appendMemory,
      capChars: 16_000,
      now: () => NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.promoted).toHaveLength(1);
    expect(mem.text()).toContain("## Deploy rule\n\nnever deploy without a go");
    expect(mem.text()).toContain("_Promoted by the dream pass from memory/2026-09-01.md (run run-abc12345, 2026-09-30)._");
  });

  it("falls back to the snapshot when the chunk id is gone, and skips a missing one", async () => {
    const mem = fakeMemory();
    const res = await promoteCandidates(
      row([
        { chunkId: "gone", currentPath: "memory/a.md", rationale: "", priorityScore: 90, heading: null, body: "snapshot body" },
        { chunkId: "gone2", currentPath: "memory/b.md", rationale: "", priorityScore: 90 },
      ]),
      { resolveChunk: () => null, readMemory: mem.readMemory, appendMemory: mem.appendMemory, capChars: 16_000, now: () => NOW },
    );
    expect(res.promoted.map((p) => p.heading)).toEqual(["a"]);
    expect(res.skipped).toEqual([{ chunkId: "gone2", currentPath: "memory/b.md", reason: "chunk-missing" }]);
    expect(res.ok).toBe(true);
  });

  it("never duplicates a body already in MEMORY.md, and that alone is a benign ok", async () => {
    const mem = fakeMemory("# MEMORY\n\nnever deploy without a go\n");
    const res = await promoteCandidates(row([{ chunkId: "c1", currentPath: "memory/x.md", rationale: "", priorityScore: 90 }]), {
      resolveChunk: () => ({ heading: "Deploy rule", body: "never deploy without a go" }),
      readMemory: mem.readMemory,
      appendMemory: mem.appendMemory,
      capChars: 16_000,
      now: () => NOW,
    });
    expect(res.ok).toBe(true);
    expect(res.promoted).toHaveLength(0);
    expect(res.skipped[0]!.reason).toBe("already-present");
  });

  it("refuses to push MEMORY.md past the cap and reports a failure when nothing else was written", async () => {
    const mem = fakeMemory("x".repeat(15_990));
    const res = await promoteCandidates(row([{ chunkId: "c1", currentPath: "memory/x.md", rationale: "", priorityScore: 90 }]), {
      resolveChunk: () => ({ heading: "H", body: "a long body ".repeat(20) }),
      readMemory: mem.readMemory,
      appendMemory: mem.appendMemory,
      capChars: 16_000,
      now: () => NOW,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/memory-at-cap/);
    expect(mem.text().length).toBe(15_990);
  });

  it("appends a mutating candidate and flags it downgraded; the report says so", async () => {
    const mem = fakeMemory();
    const res = await promoteCandidates(row([{ chunkId: "c1", currentPath: "memory/x.md", rationale: "", priorityScore: 90, action: "edit" }]), {
      resolveChunk: () => ({ heading: "H", body: "b" }),
      readMemory: mem.readMemory,
      appendMemory: mem.appendMemory,
      capChars: 16_000,
      now: () => NOW,
    });
    expect(res.promoted[0]!.downgraded).toBe(true);
    const report = formatPromoteReport("a", "run-abc12345", res);
    expect(report).toContain("promoted 1 note into MEMORY.md: H");
    expect(report).toContain("1 wanted an edit and were appended instead");
    expect(report.startsWith("-# ")).toBe(true);
  });
});

describe("registerDreamVetoTick (999.188)", () => {
  it("ticks the store, applies expired rows through applyRow, and confirms each", async () => {
    const store = createDreamVetoStore(tmp);
    await store.scheduleAutoApply({ runId: "r1", agentName: "a", candidates: [], deadline: NOW.getTime() - 1, isPriorityPass: false });
    let cb: (() => Promise<void>) | null = null;
    const onApplied = vi.fn(async () => {});
    const handle = registerDreamVetoTick({
      vetoStore: store,
      applyRow: async () => ({ ok: true }),
      now: () => NOW,
      log: { info() {}, warn() {} },
      onApplied,
      cronFactory: (_p, _o, callback) => {
        cb = callback as () => Promise<void>;
        return { stop: () => {} };
      },
    });
    await cb!();
    expect(onApplied).toHaveBeenCalledWith("r1");
    expect((await store.list())[0]!.status).toBe("applied");
    expect(await handle.runOnce()).toEqual([]);
  });

  it("a failing applyRow marks the row expired and the tick survives", async () => {
    const store = createDreamVetoStore(tmp);
    await store.scheduleAutoApply({ runId: "r2", agentName: "a", candidates: [], deadline: 0, isPriorityPass: false });
    const handle = registerDreamVetoTick({
      vetoStore: store,
      applyRow: async () => ({ ok: false, error: "nothing promoted: memory-at-cap" }),
      now: () => NOW,
      log: { info() {}, warn() {} },
      cronFactory: () => ({ stop: () => {} }),
    });
    expect(await handle.runOnce()).toEqual([]);
    const r = (await store.list())[0]!;
    expect(r.status).toBe("expired");
    expect(r.applyError).toContain("memory-at-cap");
  });
});

describe("buildDreamMachinery D-10 routing (999.188)", () => {
  const manager = {
    getMemoryStore: () => ({ getMemoryChunk: (id: string) => (id === "c1" ? { chunk_id: id, path: "p", heading: "H", body: "B", file_mtime_ms: 0, score_weight: 0 } : null) }),
    getConversationStore: () => undefined,
  } as never;

  it("with a veto store and autoPromote, promotions are scheduled and the channel gets the summary", async () => {
    const store = createDreamVetoStore(tmp);
    const posts: string[] = [];
    const m = buildDreamMachinery({
      manager,
      resolveMemoryRoot: () => tmp,
      dispatch: async () => { throw new Error("not called"); },
      now: () => NOW,
      log: pino,
      dreamRunLogDir: join(tmp, "runs"),
      vetoStore: store,
      resolveDreamPolicy: () => resolveDreamPolicy({ autoPromoteMinScore: 50 }),
      postToAgent: async (_a, text) => { posts.push(text); },
      nanoid: () => "run-m",
    });
    const applied = await m.applyDreamResult("a", completed([{ chunkId: "c1", currentPath: "memory/x.md", rationale: "", priorityScore: 70 }]));
    expect(applied).toMatchObject({ kind: "applied", runId: "run-m", autoApplyScheduled: 1 });
    expect((await store.list())[0]!.candidates[0]).toMatchObject({ body: "B", heading: "H" });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("/clawcode-dream action:veto run:run-m");
  });

  it("autoPromote:false keeps the legacy show-only applier (nothing scheduled)", async () => {
    const store = createDreamVetoStore(tmp);
    const m = buildDreamMachinery({
      manager,
      resolveMemoryRoot: () => tmp,
      dispatch: async () => { throw new Error("not called"); },
      now: () => NOW,
      log: pino,
      dreamRunLogDir: join(tmp, "runs"),
      vetoStore: store,
      resolveDreamPolicy: () => resolveDreamPolicy({ autoPromote: false }),
    });
    const applied = await m.applyDreamResult("a", completed([{ chunkId: "c1", currentPath: "memory/x.md", rationale: "", priorityScore: 99 }]));
    expect(applied.kind).toBe("applied");
    expect((applied as { runId?: string }).runId).toBeUndefined();
    expect(await store.list()).toEqual([]);
  });

  it("resolveDreamPolicy defaults: on, floor 80, 30-minute window", () => {
    expect(resolveDreamPolicy(undefined)).toEqual({ autoPromote: true, autoApplyFloor: 80, vetoWindowMs: 1_800_000 });
  });
});
