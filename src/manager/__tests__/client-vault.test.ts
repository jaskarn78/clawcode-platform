/**
 * Phase 999.132 — per-client fact vault: validation, history, atomic write,
 * listing and rendering.
 */

import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  emptyVault,
  factsAsSources,
  listClients,
  parseVault,
  readVault,
  removeFact,
  renderVault,
  setFact,
  vaultPath,
  writeVault,
} from "../client-vault.js";

const NOW = new Date("2026-09-05T20:00:00.000Z");

describe("client vault", () => {
  let ws = "";
  afterEach(() => {
    if (ws) rmSync(ws, { recursive: true, force: true });
    ws = "";
  });

  it("paths stay under <workspace>/clients and slugs/keys are validated", () => {
    expect(vaultPath("/ws", "montoya")).toBe("/ws/clients/montoya/facts.json");
    expect(() => vaultPath("/ws", "../etc")).toThrow(/invalid client slug/);
    expect(() => vaultPath("/ws", "Montoya Family")).toThrow(/invalid client slug/);
    expect(() =>
      setFact(emptyVault("m"), { key: "AUM!", value: "1", source: "s", asOf: "2026-08-30", setBy: "a", now: NOW }),
    ).toThrow(/invalid fact key/);
    expect(() => setFact(emptyVault("m"), { key: "aum", value: " ", source: "s", asOf: "2026-08-30", setBy: "a" })).toThrow(/value must be/);
    expect(() => setFact(emptyVault("m"), { key: "aum", value: "$1.2M", source: "", asOf: "2026-08-30", setBy: "a" })).toThrow(/source is required/);
    expect(() => setFact(emptyVault("m"), { key: "aum", value: "$1.2M", source: "s", asOf: "Aug 30", setBy: "a" })).toThrow(/YYYY-MM-DD/);
  });

  it("setFact keeps history newest first and removeFact archives the last value", () => {
    const v1 = setFact(emptyVault("montoya"), { key: "aum", value: "$1.2M", source: "Schwab statement", asOf: "2026-07-31", setBy: "fin-client", now: NOW });
    expect(v1.previous).toBeNull();
    expect(v1.vault.facts.aum).toMatchObject({ value: "$1.2M", source: "Schwab statement", asOf: "2026-07-31", setAt: NOW.toISOString() });
    const later = new Date("2026-09-05T21:00:00.000Z");
    const v2 = setFact(v1.vault, { key: "aum", value: "$1.3M", source: "Schwab statement", asOf: "2026-08-31", note: "after the rollover", setBy: "fin-client", now: later });
    expect(v2.previous?.value).toBe("$1.2M");
    expect(v2.vault.facts.aum?.value).toBe("$1.3M");
    expect(v2.vault.facts.aum?.note).toBe("after the rollover");
    expect(v2.vault.history.aum?.map((f) => f.value)).toEqual(["$1.2M"]);
    expect(v2.vault.updatedAt).toBe(later.toISOString());
    // Immutable: v1 untouched.
    expect(v1.vault.facts.aum?.value).toBe("$1.2M");

    const r = removeFact(v2.vault, "aum", "fin-client", later);
    expect(r.removed?.value).toBe("$1.3M");
    expect(r.vault.facts.aum).toBeUndefined();
    expect(r.vault.history.aum?.map((f) => f.value)).toEqual(["$1.3M", "$1.2M"]);
    expect(removeFact(r.vault, "nope", "a").removed).toBeNull();
  });

  it("writes atomically, reads back, tolerates hand edits and lists clients", async () => {
    ws = mkdtempSync(join(tmpdir(), "vault-"));
    const { vault } = setFact(emptyVault("montoya"), { key: "fee.annual", value: "$11,700", source: "ADV Part 2A", asOf: "2026-01-01", setBy: "fin-client", now: NOW });
    const path = await writeVault(ws, vault);
    expect(path).toBe(join(ws, "clients", "montoya", "facts.json"));
    expect(readFileSync(path, "utf8")).toContain('"fee.annual"');
    expect((await readVault(ws, "montoya")).facts["fee.annual"]?.value).toBe("$11,700");
    expect(await readVault(ws, "nobody")).toEqual(emptyVault("nobody"));

    // Hand edit: an unknown key shape and a malformed entry are dropped, the rest survives.
    mkdirSync(join(ws, "clients", "vijay"), { recursive: true });
    writeFileSync(
      join(ws, "clients", "vijay", "facts.json"),
      JSON.stringify({ facts: { aum: { value: "$2M", source: "statement", asOf: "2026-08-01", setBy: "client_a", setAt: "x" }, "Bad Key": { value: "x" }, broken: 5 }, junk: 1 }),
    );
    const vijay = await readVault(ws, "vijay");
    expect(Object.keys(vijay.facts)).toEqual(["aum"]);
    expect(await listClients(ws)).toEqual(["montoya", "vijay"]);
    expect(() => parseVault("{not json", "x")).toThrow(/not valid JSON/);
    expect(await listClients(join(ws, "missing"))).toEqual([]);
  });

  it("renders a table and source lines", () => {
    const { vault } = setFact(
      setFact(emptyVault("montoya"), { key: "aum", value: "$1.2M", source: "Schwab statement", asOf: "2026-07-31", setBy: "fin-client", now: NOW }).vault,
      { key: "fee.annual", value: "$11,700", source: "ADV Part 2A", asOf: "2026-01-01", setBy: "fin-client", now: NOW },
    );
    const text = renderVault(vault);
    expect(text).toContain("Facts on file for montoya (2):");
    expect(text).toContain("| aum | $1.2M | Schwab statement | 2026-07-31 | fin-client |");
    expect(renderVault(emptyVault("x"))).toBe("No facts on file for x.");
    expect(factsAsSources(vault)).toEqual(["aum: $1.2M (Schwab statement, as of 2026-07-31)", "fee.annual: $11,700 (ADV Part 2A, as of 2026-01-01)"]);
    expect(factsAsSources(vault, ["aum", "missing"])).toEqual(["aum: $1.2M (Schwab statement, as of 2026-07-31)"]);
  });
});
