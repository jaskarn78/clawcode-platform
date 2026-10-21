import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { VerboseState } from "../verbose-state.js";

/**
 * Phase 117 Plan 117-11 T02 — CRUD assertions against an in-memory SQLite
 * `verbose_channels` table. Mirrors `src/usage/advisor-budget.test.ts`'s
 * `:memory:` pattern. Six assertions per the plan T02 spec.
 */
describe("VerboseState", () => {
  let db: InstanceType<typeof Database>;
  let state: VerboseState;

  beforeEach(() => {
    db = new Database(":memory:");
    state = new VerboseState(db);
  });

  // A — default level is "normal" for an unseen channel.
  it("A: getLevel returns 'normal' for an unseen channel", () => {
    expect(state.getLevel("c1")).toBe("normal");
  });

  // B — setLevel writes and getLevel reads it back.
  it("B: setLevel('verbose') is read back by getLevel", () => {
    state.setLevel("c1", "verbose");
    expect(state.getLevel("c1")).toBe("verbose");
  });

  // C — round-trip + per-channel isolation.
  it("C: per-channel isolation — c1 verbose, c2 normal, no cross-talk", () => {
    state.setLevel("c1", "verbose");
    state.setLevel("c2", "normal");
    expect(state.getLevel("c1")).toBe("verbose");
    expect(state.getLevel("c2")).toBe("normal");
  });

  // D — getStatus after setLevel returns channelId + level + ISO timestamp.
  it("D: getStatus after setLevel returns ISO 8601 updatedAt and matching level", () => {
    state.setLevel("c1", "verbose");
    const status = state.getStatus("c1");
    expect(status.channelId).toBe("c1");
    expect(status.level).toBe("verbose");
    expect(status.updatedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  // E — getStatus for never-set channel returns the placeholder sentinel.
  it("E: getStatus for never-set channel returns default + placeholder updatedAt", () => {
    const status = state.getStatus("never-set");
    expect(status.channelId).toBe("never-set");
    expect(status.level).toBe("normal");
    expect(status.updatedAt).toBe("(never set — using default)");
  });

  // F — upsert semantics: re-setLevel on same channel does NOT add a row.
  it("F: setLevel is an upsert — row count stays at 1 across two writes", () => {
    state.setLevel("c1", "verbose");
    state.setLevel("c1", "normal");
    expect(state.getLevel("c1")).toBe("normal");
    const count = (
      db.prepare("SELECT COUNT(*) as n FROM verbose_channels").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(1);
  });
});
