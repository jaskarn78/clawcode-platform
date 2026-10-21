import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  pruneWorkflowArtifacts,
  DEFAULT_KEEP_WORKFLOWS,
} from "../prune-workflow-artifacts.js";

const log = pino({ level: "silent" });

/** In-memory fs doubles: names + mtimes in, removals out. */
function fsOf(entries: Record<string, number>, opts: { rmFails?: string } = {}) {
  const removed: string[] = [];
  return {
    removed,
    deps: {
      logger: log,
      readdir: (async () => Object.keys(entries)) as never,
      stat: (async (p: string) => {
        const name = p.split("/").pop()!;
        if (!(name in entries)) throw new Error("ENOENT");
        return { isDirectory: () => true, mtimeMs: entries[name]! };
      }) as never,
      rm: (async (p: string) => {
        const name = p.split("/").pop()!;
        if (opts.rmFails === name) throw new Error("EBUSY");
        removed.push(name);
      }) as never,
    },
  };
}

describe("pruneWorkflowArtifacts", () => {
  it("keeps the N most recent and removes the rest", async () => {
    const f = fsOf({ wf_aaaa: 1, wf_bbbb: 2, wf_cccc: 3, wf_dddd: 4 });
    const res = await pruneWorkflowArtifacts("/ws", 2, f.deps);
    expect([...res.removed].sort()).toEqual(["wf_aaaa", "wf_bbbb"]);
    expect(f.removed.sort()).toEqual(["wf_aaaa", "wf_bbbb"]);
  });

  it("is a no-op when the count is at or under the limit", async () => {
    const f = fsOf({ wf_aaaa: 1, wf_bbbb: 2 });
    expect((await pruneWorkflowArtifacts("/ws", 2, f.deps)).removed).toEqual([]);
    expect(f.removed).toEqual([]);
  });

  it("NEVER touches an entry that is not a workflow directory", async () => {
    // This runs inside a live agent workspace. Anything it does not recognise
    // is somebody else's data.
    const f = fsOf({
      wf_aaaa: 1,
      wf_bbbb: 2,
      wf_cccc: 3,
      notes: 0,
      ".git": 0,
      memory: 0,
      "important.md": 0,
    });
    await pruneWorkflowArtifacts("/ws", 1, f.deps);
    expect(f.removed.sort()).toEqual(["wf_aaaa", "wf_bbbb"]);
  });

  it("returns cleanly when there is no workflows directory at all", async () => {
    const res = await pruneWorkflowArtifacts("/ws", 5, {
      logger: log,
      readdir: (async () => {
        throw new Error("ENOENT");
      }) as never,
    });
    expect(res).toEqual({ scanned: 0, removed: [] });
  });

  it("keeps going when one removal fails", async () => {
    const f = fsOf({ wf_aaaa: 1, wf_bbbb: 2, wf_cccc: 3 }, { rmFails: "wf_aaaa" });
    const res = await pruneWorkflowArtifacts("/ws", 1, f.deps);
    expect(res.removed).toEqual(["wf_bbbb"]);
    expect(f.removed).toEqual(["wf_bbbb"]);
  });

  it("retains a sane default", () => {
    expect(DEFAULT_KEEP_WORKFLOWS).toBeGreaterThanOrEqual(10);
  });
});
