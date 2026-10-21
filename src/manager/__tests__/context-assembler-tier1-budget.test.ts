/**
 * Phase 115 Plan 03 sub-scope 1 / T01 — bounded always-injected tier
 * (`INJECTED_MEMORY_MAX_CHARS = 16,000`) and `STABLE_PREFIX_MAX_TOKENS = 8,000`
 * constants, plus the four carved `ContextSources` sub-source fields
 * (identitySoulFingerprint / identityFile / identityCapabilityManifest /
 * identityMemoryAutoload).
 *
 * Verifies the constants are exported with the locked Phase 115 values, and
 * that the assembler composes the four sub-sources into the same byte-shape
 * as the legacy `identityStr` concatenation when the four are populated.
 *
 * The MEMORY.md head-tail-truncation behavior + daemon-side warn live in
 * `session-config-115-truncation-warn.test.ts` (since they exercise the
 * upstream session-config path that owns the read-and-truncate logic).
 */

import { describe, it, expect } from "vitest";
import {
  assembleContext,
  INJECTED_MEMORY_MAX_CHARS,
  STABLE_PREFIX_MAX_TOKENS,
  type ContextSources,
} from "../context-assembler.js";

function makeSources(overrides: Partial<ContextSources> = {}): ContextSources {
  return {
    identity: "",
    hotMemories: "",
    toolDefinitions: "",
    graphContext: "",
    discordBindings: "",
    contextSummary: "",
    ...overrides,
  } as ContextSources;
}

describe("Phase 115 Plan 03 sub-scope 1 — INJECTED_MEMORY_MAX_CHARS constant", () => {
  it("is the D-01 locked value 16_000 chars (≈ 4K tokens)", () => {
    expect(INJECTED_MEMORY_MAX_CHARS).toBe(16_000);
  });
});

describe("Phase 115 Plan 03 sub-scope 1 — STABLE_PREFIX_MAX_TOKENS constant", () => {
  it("is the D-02 locked outer cap of 8_000 tokens", () => {
    expect(STABLE_PREFIX_MAX_TOKENS).toBe(8_000);
  });
});

describe("Phase 115 Plan 03 sub-scope 1 — composeCarvedIdentity rendering", () => {
  it("when only legacy `identity` is provided, renders verbatim (back-compat)", () => {
    const sources = makeSources({
      identity:
        "Persona: clawdy\n\nYou are clawdy. Be helpful.\n\n## Long-term memory (MEMORY.md)\n\nremembered things\n",
    });
    const { stablePrefix } = assembleContext(sources);
    // Legacy single `identity` field renders verbatim; no carved-mode path.
    expect(stablePrefix).toContain("Persona: clawdy");
    expect(stablePrefix).toContain("Long-term memory (MEMORY.md)");
  });

  it("when four sub-sources are provided, composes them in fixed order", () => {
    const sources = makeSources({
      identity: "IGNORED-COMPOUND-LEGACY", // ignored when carved fields are present
      identitySoulFingerprint: "## SOUL Fingerprint\n- vibe: dry-wit",
      identityFile: "## My persona\n\nI am clawdy.",
      identityCapabilityManifest:
        "Your name is clawdy. When using memory_lookup, pass 'clawdy' as the agent parameter.\nYou have dream consolidation enabled.",
      identityMemoryAutoload:
        "## Long-term memory things\n- I remember thing A.",
    });
    const { stablePrefix } = assembleContext(sources);

    // The IGNORED-COMPOUND-LEGACY string MUST NOT appear (carved path took over).
    expect(stablePrefix).not.toContain("IGNORED-COMPOUND-LEGACY");

    // All four sub-sources land verbatim in the rendered prefix.
    expect(stablePrefix).toContain("## SOUL Fingerprint\n- vibe: dry-wit");
    expect(stablePrefix).toContain("## My persona\n\nI am clawdy.");
    expect(stablePrefix).toContain("Your name is clawdy.");
    expect(stablePrefix).toContain("dream consolidation enabled");
    expect(stablePrefix).toContain("## Long-term memory (MEMORY.md)");
    expect(stablePrefix).toContain("I remember thing A.");

    // Order check: SOUL fingerprint < IDENTITY.md < capability < MEMORY.md
    const soulIdx = stablePrefix.indexOf("SOUL Fingerprint");
    const identityIdx = stablePrefix.indexOf("My persona");
    const capabilityIdx = stablePrefix.indexOf("Your name is clawdy");
    const memoryIdx = stablePrefix.indexOf(
      "## Long-term memory (MEMORY.md)",
    );
    expect(soulIdx).toBeGreaterThanOrEqual(0);
    expect(identityIdx).toBeGreaterThan(soulIdx);
    expect(capabilityIdx).toBeGreaterThan(identityIdx);
    expect(memoryIdx).toBeGreaterThan(capabilityIdx);
  });

  it("when only some carved fields are populated, omits empty ones (no empty headers)", () => {
    const sources = makeSources({
      // No SOUL fingerprint, no IDENTITY.md
      identityCapabilityManifest:
        "Your name is barebones. You have no extras.",
      identityMemoryAutoload: "", // explicit empty — no MEMORY.md section header
    });
    const { stablePrefix } = assembleContext(sources);

    expect(stablePrefix).toContain("Your name is barebones.");
    // No empty MEMORY.md header (composer treats empty body as omitted).
    expect(stablePrefix).not.toContain("## Long-term memory (MEMORY.md)");
  });

  it("when MEMORY.md sub-source is non-empty, renders the canonical header", () => {
    const sources = makeSources({
      identityCapabilityManifest: "Your name is alice.",
      identityMemoryAutoload: "remembered facts",
    });
    const { stablePrefix } = assembleContext(sources);
    expect(stablePrefix).toContain(
      "## Long-term memory (MEMORY.md)\n\nremembered facts",
    );
  });

  it("when ALL four carved fields are empty strings, renders nothing identity-shaped", () => {
    const sources = makeSources({
      identitySoulFingerprint: "",
      identityFile: "",
      identityCapabilityManifest: "",
      identityMemoryAutoload: "",
    });
    const { stablePrefix } = assembleContext(sources);
    // Composer returns "" — assembler omits the identity stable part entirely.
    expect(stablePrefix).toBe("");
  });
});
