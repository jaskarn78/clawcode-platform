/**
 * Memory overhaul 2026-10-25 (WP5) - memory_save tells the agent what dedup
 * did (created / duplicate / superseded) instead of always "Memory saved".
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { formatMemorySaveText } from "../tools/memory-save-text.js";

describe("formatMemorySaveText", () => {
  it("created", () => {
    expect(formatMemorySaveText({ id: "m1", status: "created" })).toBe("Memory saved (id: m1, status: created)");
  });

  it("duplicate says nothing was stored and names the existing id", () => {
    const text = formatMemorySaveText({ id: "m0", status: "duplicate" });
    expect(text).toContain("status: duplicate");
    expect(text).toContain("m0");
    expect(text).toMatch(/not stored/i);
  });

  it("superseded names both the new and the retired id", () => {
    const text = formatMemorySaveText({ id: "m2", status: "superseded", supersedes: "m1" });
    expect(text).toContain("id: m2");
    expect(text).toContain("status: superseded");
    expect(text).toContain("m1");
    expect(text).toMatch(/hidden from search/);
  });

  it("an old daemon without a status keeps the pre-WP5 text", () => {
    expect(formatMemorySaveText({ id: "m3" })).toBe("Memory saved (id: m3)");
  });

  it("owner scope is unchanged", () => {
    expect(formatMemorySaveText({ id: "f1", scope: "owner", owner: "jas", action: "refreshed" })).toBe(
      "Owner fact refreshed for jas (id: f1); every agent they own will recall it.",
    );
  });

  it("stays import-free (it is bundled into the standalone MCP server)", () => {
    const src = readFileSync(new URL("../tools/memory-save-text.ts", import.meta.url), "utf-8");
    expect(src).not.toMatch(/^import /m);
  });
});
