/**
 * Phase 100 follow-up — autoStart schema acceptance + defaults.
 *
 * Pins the additive-optional schema contract:
 *   - AS-SCHEMA-1: agentSchema accepts autoStart: boolean
 *   - AS-SCHEMA-2: omitting autoStart parses as true (existing v2.5/2.6 yaml
 *                  configs unchanged — the 11-agent fleet inherits true)
 *   - AS-SCHEMA-3: defaultsSchema accepts autoStart with default true
 *   - AS-SCHEMA-4: defaultsSchema applies default true when omitted
 */

import { describe, it, expect } from "vitest";
import { agentSchema, defaultsSchema } from "../schema.js";

describe("agentSchema.autoStart (Phase 100 follow-up)", () => {
  it("AS-SCHEMA-1: agentSchema accepts autoStart: false", () => {
    const result = agentSchema.safeParse({
      name: "fin-tax",
      autoStart: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoStart).toBe(false);
    }
  });

  it("AS-SCHEMA-1b: agentSchema accepts autoStart: true", () => {
    const result = agentSchema.safeParse({
      name: "fin-client",
      autoStart: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoStart).toBe(true);
    }
  });

  it("AS-SCHEMA-2: missing autoStart parses as undefined at the agent level (loader.ts falls back to defaults.autoStart — same additive-optional pattern as memoryAutoLoad / greetOnRestart)", () => {
    // Mirrors the established blueprint: agent fields stay .optional() so
    // the loader can detect operator omission and fall back to defaults.X.
    // The "default true" lives on defaultsSchema.autoStart — the resolver
    // composes the two layers (see AS-2 in loader-autoStart.test.ts).
    const result = agentSchema.safeParse({
      name: "test-agent",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoStart).toBeUndefined();
    }
  });

  it("AS-SCHEMA-2b: rejects non-boolean autoStart (e.g. string 'false')", () => {
    const result = agentSchema.safeParse({
      name: "test-agent",
      autoStart: "false", // string, not boolean — reject
    });
    expect(result.success).toBe(false);
  });
});

describe("defaultsSchema.autoStart (Phase 100 follow-up)", () => {
  it("AS-SCHEMA-3: defaultsSchema accepts autoStart with default true (omission yields true)", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoStart).toBe(true);
    }
  });

  it("AS-SCHEMA-4: defaultsSchema accepts explicit autoStart: false (operator can flip the fleet polarity)", () => {
    const result = defaultsSchema.safeParse({ autoStart: false });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.autoStart).toBe(false);
    }
  });
});
