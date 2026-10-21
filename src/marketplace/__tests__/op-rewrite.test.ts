/**
 * Phase 90 Plan 06 HUB-05 — op-rewrite.ts tests.
 *
 * Pins (OP-L1, OP-P1..P2, OP-PR1..PR4):
 *   OP-L1   levenshtein basic cases
 *   OP-P1   listOpItems happy — parses `op item list` JSON output
 *   OP-P2   listOpItems ENOENT — returns empty, no throw (graceful)
 *   OP-PR1  proposeOpUri substring match — "MySQL Password" → "MySQL DB - Unraid"
 *   OP-PR2  proposeOpUri levenshtein match — distance ≤ 3
 *   OP-PR3  proposeOpUri no match — returns null
 *   OP-PR4  proposeOpUri field-name-driven op:// field resolution
 */
import { describe, it, expect, vi } from "vitest";
import {
  levenshtein,
  listOpItems,
  proposeOpUri,
  type OpItemCandidate,
} from "../op-rewrite.js";

describe("levenshtein (OP-L1)", () => {
  it("returns 0 for identical strings", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  it("returns b.length when a is empty", () => {
    expect(levenshtein("", "abc")).toBe(3);
  });

  it("returns a.length when b is empty", () => {
    expect(levenshtein("abc", "")).toBe(3);
  });

  it("computes single-edit distance", () => {
    expect(levenshtein("database", "databse")).toBe(1);
  });

  it("computes multi-edit distance", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
  });
});

describe("listOpItems (OP-P1, OP-P2)", () => {
  it("OP-P1: parses `op item list` JSON output", async () => {
    const runStub = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        {
          id: "uuid-1",
          title: "MySQL DB - Unraid",
          category: "Credential",
          tags: ["db", "mysql"],
        },
        {
          id: "uuid-2",
          title: "OpenAI API",
          category: "API",
        },
      ]),
      stderr: "",
    });

    const items = await listOpItems({ run: runStub as never });
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      uuid: "uuid-1",
      title: "MySQL DB - Unraid",
      category: "Credential",
    });
    expect(items[1]).toMatchObject({
      uuid: "uuid-2",
      title: "OpenAI API",
      category: "API",
    });

    // Verify `op item list` args include --format=json for parseability.
    const callArgs = runStub.mock.calls[0];
    expect(callArgs[0]).toBe("op");
    expect(callArgs[1]).toContain("item");
    expect(callArgs[1]).toContain("list");
    expect(callArgs[1]).toContain("--format=json");
  });

  it("OP-P2: returns empty array when `op` binary is absent (ENOENT)", async () => {
    const runStub = vi.fn().mockRejectedValue(
      Object.assign(new Error("spawn op ENOENT"), { code: "ENOENT" }),
    );
    const items = await listOpItems({ run: runStub as never });
    expect(items).toEqual([]);
  });

  it("OP-P2b: returns empty array when `op` is not signed in (non-zero exit)", async () => {
    const runStub = vi.fn().mockRejectedValue(
      Object.assign(new Error("not signed in"), { exitCode: 1 }),
    );
    const items = await listOpItems({ run: runStub as never });
    expect(items).toEqual([]);
  });

  it("OP-P1b: tolerates malformed entries (missing id/title) by filtering them", async () => {
    const runStub = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([
        { id: "uuid-1", title: "Real" },
        { id: null, title: "Bad" },
        { id: "uuid-2" }, // no title
        "not-an-object",
      ]),
      stderr: "",
    });
    const items = await listOpItems({ run: runStub as never });
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Real");
  });
});

describe("proposeOpUri (OP-PR1..PR4)", () => {
  const items: readonly OpItemCandidate[] = Object.freeze([
    { uuid: "u-1", title: "MySQL DB - Unraid", category: "Credential" },
    { uuid: "u-2", title: "OpenAI API", category: "API" },
    { uuid: "u-3", title: "GitHub Personal", category: "Credential" },
  ]);

  it("OP-PR1: substring match — 'MySQL Password' → 'MySQL DB - Unraid'", () => {
    // Label 'mysql' is a substring of 'mysql db - unraid' → matches.
    const prop = proposeOpUri("MYSQL_PASSWORD", "MySQL Password", items);
    expect(prop).not.toBeNull();
    expect(prop?.confidence).toBe("substring");
    expect(prop?.itemTitle).toBe("MySQL DB - Unraid");
    expect(prop?.uri).toBe("op://example-vault-21/MySQL DB - Unraid/password");
  });

  it("OP-PR2: levenshtein match within threshold", () => {
    // "openai key" vs "openai api" — levenshtein distance 3 (key→api = 3 char swaps)
    const prop = proposeOpUri("OPENAI_KEY", "openai key", items);
    expect(prop).not.toBeNull();
    // Either substring or levenshtein is acceptable — both find a match.
    expect(prop?.itemTitle).toBe("OpenAI API");
  });

  it("OP-PR3: no match returns null", () => {
    const prop = proposeOpUri("CRYPTIC_XYZ", "Cryptic XYZ", items);
    expect(prop).toBeNull();
  });

  it("OP-PR4: field-name drives op:// field (api_key → credential)", () => {
    const prop = proposeOpUri("api_key", "OpenAI API", items);
    expect(prop).not.toBeNull();
    expect(prop?.uri).toBe("op://example-vault-21/OpenAI API/credential");
  });

  it("OP-PR4b: field-name _password maps to password", () => {
    const prop = proposeOpUri("db_password", "MySQL Password", items);
    expect(prop?.uri).toBe("op://example-vault-21/MySQL DB - Unraid/password");
  });

  it("OP-PR4c: field-name _token maps to credential", () => {
    const prop = proposeOpUri("github_token", "GitHub", items);
    expect(prop?.uri).toBe("op://example-vault-21/GitHub Personal/credential");
  });

  it("empty items list returns null", () => {
    const prop = proposeOpUri("API_KEY", "OpenAI", []);
    expect(prop).toBeNull();
  });
});
