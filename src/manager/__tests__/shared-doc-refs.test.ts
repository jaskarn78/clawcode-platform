/**
 * UX-A (2026-08-26) — SharedDocRefStore + superseded-share composition.
 *
 * Pure-module tests: no discord.js, no timers. The daemon's share-file
 * IPC case owns the side effects; everything decision-shaped is pinned
 * here.
 */

import { describe, it, expect } from "vitest";
import {
  SharedDocRefStore,
  sharedDocKey,
  supersededContent,
  SUPERSEDED_BANNER,
  SHARED_DOC_MAX_AGE_MS,
  SHARED_DOC_MAX_ENTRIES,
  type SharedDocRef,
} from "../shared-doc-refs.js";

const ref = (overrides: Partial<SharedDocRef> = {}): SharedDocRef => ({
  messageId: "m1",
  channelId: "c1",
  content: "",
  at: 1_000_000,
  ...overrides,
});

describe("sharedDocKey", () => {
  it("is case-insensitive and strips the final extension", () => {
    expect(sharedDocKey("fin-client", "Vallejos-Next-Call.PDF")).toBe(
      "fin-client:vallejos-next-call",
    );
    expect(sharedDocKey("fin-client", "vallejos-next-call.pdf")).toBe(
      "fin-client:vallejos-next-call",
    );
  });

  it("keeps distinct versioned FILENAMES distinct (report-v2 vs report-v3)", () => {
    expect(sharedDocKey("a", "report-v2.pdf")).not.toBe(
      sharedDocKey("a", "report-v3.pdf"),
    );
  });

  it("scopes by agent — same filename, different agents never collide", () => {
    expect(sharedDocKey("fin-client", "plan.pdf")).not.toBe(
      sharedDocKey("fin-research", "plan.pdf"),
    );
  });

  it("only strips the FINAL extension segment", () => {
    expect(sharedDocKey("a", "statement.2026.pdf")).toBe("a:statement.2026");
  });
});

describe("SharedDocRefStore.record", () => {
  it("returns undefined for a first-time share", () => {
    const store = new SharedDocRefStore();
    expect(store.record("k", ref())).toBeUndefined();
  });

  it("returns the displaced previous ref on a re-share (A→B→C chain edits B when C ships)", () => {
    const store = new SharedDocRefStore();
    const a = ref({ messageId: "A", at: 1000 });
    const b = ref({ messageId: "B", at: 2000 });
    const c = ref({ messageId: "C", at: 3000 });
    expect(store.record("k", a)).toBeUndefined();
    expect(store.record("k", b)).toEqual(a);
    expect(store.record("k", c)).toEqual(b);
    expect(store.size).toBe(1);
  });

  it("does NOT return a previous ref older than SHARED_DOC_MAX_AGE_MS", () => {
    const store = new SharedDocRefStore();
    const old = ref({ messageId: "old", at: 0 });
    store.record("k", old);
    const fresh = ref({
      messageId: "new",
      at: SHARED_DOC_MAX_AGE_MS + 1,
    });
    expect(store.record("k", fresh)).toBeUndefined();
  });

  it("prunes stale entries on write and caps total entries (oldest evicted)", () => {
    const store = new SharedDocRefStore();
    for (let i = 0; i < SHARED_DOC_MAX_ENTRIES + 10; i++) {
      store.record(`k${i}`, ref({ messageId: `m${i}`, at: 5_000_000 + i }));
    }
    expect(store.size).toBe(SHARED_DOC_MAX_ENTRIES);
  });
});

describe("supersededContent", () => {
  it("prepends the banner to a captioned share", () => {
    expect(supersededContent(ref({ content: "Updated for tonight, 9 pages" }))).toBe(
      `${SUPERSEDED_BANNER}\nUpdated for tonight, 9 pages`,
    );
  });

  it("is the bare banner for a caption-less share", () => {
    expect(supersededContent(ref({ content: "" }))).toBe(SUPERSEDED_BANNER);
  });
});
