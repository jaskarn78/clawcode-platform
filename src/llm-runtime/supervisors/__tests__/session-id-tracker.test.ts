/**
 * Phase 140 Plan 07 — v3 resume-session-id tracker tests (140-04 Deferred #2).
 *
 * Proves the sync-getter / async-cache bridge and its fail-open contract: a
 * never-refreshed or failed-refresh tracker returns null (→ fresh spawn), a
 * successful refresh caches the newest session id, and a transient failure or
 * empty read never clobbers a known id.
 */

import { describe, it, expect, vi } from "vitest";
import {
  pickLatestSessionId,
  SessionIdTracker,
  type ListSessionsFn,
} from "../session-id-tracker.js";

describe("pickLatestSessionId", () => {
  it("returns null for an empty list", () => {
    expect(pickLatestSessionId([])).toBeNull();
  });

  it("picks the most-recently-modified session id", () => {
    const latest = pickLatestSessionId([
      { sessionId: "old", lastModified: 100 },
      { sessionId: "newest", lastModified: 300 },
      { sessionId: "mid", lastModified: 200 },
    ]);
    expect(latest).toBe("newest");
  });

  it("handles a single session", () => {
    expect(
      pickLatestSessionId([{ sessionId: "only", lastModified: 42 }]),
    ).toBe("only");
  });
});

describe("SessionIdTracker", () => {
  it("get() is null before any refresh (→ fresh spawn)", () => {
    const tracker = new SessionIdTracker({
      cwd: "/proj",
      listSessions: vi.fn(),
    });
    expect(tracker.get()).toBeNull();
  });

  it("refresh() caches the newest session id and passes cwd as dir", async () => {
    const listSessions = vi.fn(async () => [
      { sessionId: "s1", lastModified: 10 },
      { sessionId: "s2", lastModified: 99 },
    ]) satisfies ListSessionsFn;
    const tracker = new SessionIdTracker({ cwd: "/proj", listSessions });

    await tracker.refresh();

    expect(listSessions).toHaveBeenCalledWith({ dir: "/proj" });
    expect(tracker.get()).toBe("s2");
  });

  it("refresh() failure keeps the last-known id (fail-open) + logs once", async () => {
    const warn = vi.fn();
    let call = 0;
    const listSessions: ListSessionsFn = async () => {
      call += 1;
      if (call === 1) return [{ sessionId: "good", lastModified: 5 }];
      throw new Error("store unavailable");
    };
    const tracker = new SessionIdTracker({
      cwd: "/proj",
      listSessions,
      log: { warn },
    });

    await tracker.refresh(); // success → caches "good"
    expect(tracker.get()).toBe("good");

    await tracker.refresh(); // throws → keeps "good"
    expect(tracker.get()).toBe("good");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("refresh() with an empty read does not clobber a known id", async () => {
    let call = 0;
    const listSessions: ListSessionsFn = async () => {
      call += 1;
      return call === 1 ? [{ sessionId: "known", lastModified: 1 }] : [];
    };
    const tracker = new SessionIdTracker({ cwd: "/proj", listSessions });

    await tracker.refresh(); // caches "known"
    await tracker.refresh(); // empty → unchanged
    expect(tracker.get()).toBe("known");
  });
});
