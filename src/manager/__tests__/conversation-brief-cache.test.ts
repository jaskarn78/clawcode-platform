import { describe, it, expect } from "vitest";
import {
  ConversationBriefCache,
  computeBriefFingerprint,
} from "../conversation-brief-cache.js";

/**
 * Phase 73 Plan 02 — unit tests for the per-agent conversation-brief cache.
 *
 * Covers the 5 enumerated cases:
 *  1. miss → fill → hit (get/set round-trip).
 *  2. fingerprint invalidation when terminated-session set changes.
 *  3. explicit invalidate(agent) busts the entry.
 *  4. two-agent isolation — invalidating A doesn't touch B.
 *  5. computeBriefFingerprint is deterministic + sort-invariant, and
 *     handles the empty-array case without collapsing to "".
 */

describe("computeBriefFingerprint", () => {
  it("returns a stable 16-char hex string for empty input", () => {
    const fp = computeBriefFingerprint([]);
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
    // Empty input → sha256 of empty string sliced, NOT "".
    expect(fp.length).toBe(16);
    // Deterministic across calls.
    expect(computeBriefFingerprint([])).toBe(fp);
  });

  it("is sort-invariant — same set of IDs yields the same fingerprint", () => {
    const a = computeBriefFingerprint(["a", "b", "c"]);
    const b = computeBriefFingerprint(["c", "a", "b"]);
    const c = computeBriefFingerprint(["b", "c", "a"]);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("changes when the ID set changes", () => {
    const before = computeBriefFingerprint(["s1", "s2"]);
    const after = computeBriefFingerprint(["s1", "s2", "s3"]);
    expect(before).not.toBe(after);
  });

  it("produces a 16-char hex string", () => {
    const fp = computeBriefFingerprint(["session-one", "session-two"]);
    expect(fp).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe("ConversationBriefCache", () => {
  it("miss → set → hit round-trip returns the stored entry", () => {
    const cache = new ConversationBriefCache();
    expect(cache.get("agent-a")).toBeUndefined();

    const entry = { fingerprint: "abc123", briefBlock: "## Recent Sessions\n…" };
    cache.set("agent-a", entry);

    const hit = cache.get("agent-a");
    expect(hit).toBeDefined();
    expect(hit!.fingerprint).toBe("abc123");
    expect(hit!.briefBlock).toBe("## Recent Sessions\n…");
  });

  it("stored entries are frozen (immutable)", () => {
    const cache = new ConversationBriefCache();
    cache.set("agent-a", { fingerprint: "fp1", briefBlock: "body" });
    const entry = cache.get("agent-a")!;
    expect(Object.isFrozen(entry)).toBe(true);
    // Mutation attempts fail silently in non-strict mode; in strict mode
    // (ESM/TS default) they throw. Either way the value is unchanged.
    expect(() => {
      (entry as unknown as { fingerprint: string }).fingerprint = "mutated";
    }).toThrow();
    expect(cache.get("agent-a")!.fingerprint).toBe("fp1");
  });

  it("fingerprint change invalidates the cache for a read-compare loop", () => {
    // Simulates the session-config caller pattern: compute fingerprint,
    // compare to cached entry's fingerprint, miss → re-compute brief.
    const cache = new ConversationBriefCache();
    const oldFingerprint = computeBriefFingerprint(["s1", "s2"]);
    cache.set("agent-a", {
      fingerprint: oldFingerprint,
      briefBlock: "old brief body",
    });

    const newFingerprint = computeBriefFingerprint(["s1", "s2", "s3"]);
    const cached = cache.get("agent-a");
    expect(cached).toBeDefined();
    expect(cached!.fingerprint).toBe(oldFingerprint);
    expect(cached!.fingerprint).not.toBe(newFingerprint);
    // The caller's fingerprint-compare miss path would re-call the brief
    // assembler and `set` a new entry — simulate that and verify.
    cache.set("agent-a", {
      fingerprint: newFingerprint,
      briefBlock: "new brief body",
    });
    expect(cache.get("agent-a")!.briefBlock).toBe("new brief body");
  });

  it("invalidate(agent) removes the entry — next read misses", () => {
    const cache = new ConversationBriefCache();
    cache.set("agent-a", { fingerprint: "fp-a", briefBlock: "body-a" });
    expect(cache.get("agent-a")).toBeDefined();

    cache.invalidate("agent-a");
    expect(cache.get("agent-a")).toBeUndefined();
  });

  it("two-agent isolation — invalidating A does not affect B", () => {
    const cache = new ConversationBriefCache();
    cache.set("agent-a", { fingerprint: "fp-a", briefBlock: "body-a" });
    cache.set("agent-b", { fingerprint: "fp-b", briefBlock: "body-b" });
    expect(cache.size()).toBe(2);

    cache.invalidate("agent-a");
    expect(cache.get("agent-a")).toBeUndefined();
    expect(cache.get("agent-b")).toBeDefined();
    expect(cache.get("agent-b")!.fingerprint).toBe("fp-b");
    expect(cache.size()).toBe(1);
  });

  it("clear() empties the whole cache", () => {
    const cache = new ConversationBriefCache();
    cache.set("agent-a", { fingerprint: "fp-a", briefBlock: "body-a" });
    cache.set("agent-b", { fingerprint: "fp-b", briefBlock: "body-b" });
    expect(cache.size()).toBe(2);

    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get("agent-a")).toBeUndefined();
    expect(cache.get("agent-b")).toBeUndefined();
  });

  it("invalidate on an absent agent is a no-op (no throw)", () => {
    const cache = new ConversationBriefCache();
    expect(() => cache.invalidate("never-set")).not.toThrow();
    expect(cache.size()).toBe(0);
  });
});
