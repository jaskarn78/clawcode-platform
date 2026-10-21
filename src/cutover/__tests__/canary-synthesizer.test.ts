/**
 * Phase 92 Plan 05 Task 1 (RED) — canary-synthesizer tests.
 *
 * Pins the contract for `synthesizeCanaryPrompts(deps)` defined in the plan's
 * <interfaces> block. RED gate: src/cutover/canary-synthesizer.ts does not
 * yet exist so import-time failure triggers vitest red.
 *
 * Behavioral pins (D-08):
 *   S1 happy-path  : 2 intents → ONE dispatch call → returns sorted prompts
 *   S2 limit-applied: 30 intents + limit 20 → only top 20 by count fed to dispatcher
 *   S3 no-intents  : empty topIntents → outcome.kind === "no-intents"; zero dispatch
 *   S4 schema-mismatch: dispatcher returns invalid JSON → schema-validation-failed
 */

import { describe, it, expect, vi } from "vitest";

import {
  synthesizeCanaryPrompts,
  type SynthesizerDeps,
} from "../canary-synthesizer.js";

function makeLog() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as import("pino").Logger;
}

const CANNED_TWO_PROMPTS = JSON.stringify([
  { intent: "a", prompt: "Tell me about A." },
  { intent: "b", prompt: "Tell me about B." },
]);

function baseDeps(overrides: Partial<SynthesizerDeps> = {}): SynthesizerDeps {
  const dispatch = vi.fn<SynthesizerDeps["dispatcher"]["dispatch"]>(async () => CANNED_TWO_PROMPTS);
  return {
    agent: "fin-client",
    topIntents: [
      { intent: "a", count: 10 },
      { intent: "b", count: 5 },
    ],
    dispatcher: {
      dispatch: dispatch as unknown as SynthesizerDeps["dispatcher"]["dispatch"],
    },
    log: makeLog(),
    ...overrides,
  };
}

describe("synthesizeCanaryPrompts — S1 happy path", () => {
  it("dispatcher called once; returns synthesized prompts sorted by intent ASC", async () => {
    const dispatch = vi.fn<SynthesizerDeps["dispatcher"]["dispatch"]>(async () => CANNED_TWO_PROMPTS);
    const deps = baseDeps({
      topIntents: [
        // Intentionally reverse-sorted to prove the synthesizer doesn't depend
        // on input order for slicing OR output sort.
        { intent: "b", count: 5 },
        { intent: "a", count: 10 },
      ],
      dispatcher: {
        dispatch:
          dispatch as unknown as SynthesizerDeps["dispatcher"]["dispatch"],
      },
    });

    const outcome = await synthesizeCanaryPrompts(deps);

    expect(dispatch).toHaveBeenCalledTimes(1);
    // The dispatcher prompt should reference both intents.
    // SynthesizerDispatchFn signature: (origin, agentName, message, options?)
    // — message is index [2]. Previous code had a fallback to `[0]` which
    // pre-dated the origin-first signature; vitest 4 tuple-narrowing
    // surfaced the dead branch.
    const promptArg = dispatch.mock.calls[0]?.[2] ?? "";
    expect(promptArg).toContain("a");
    expect(promptArg).toContain("b");
    expect(outcome.kind).toBe("synthesized");
    if (outcome.kind === "synthesized") {
      expect(outcome.prompts.map((p) => p.intent)).toEqual(["a", "b"]);
      expect(outcome.prompts[0]?.prompt.length).toBeGreaterThan(0);
    }
  });
});

describe("synthesizeCanaryPrompts — S2 limit applied", () => {
  it("30 topIntents + limit 20 → dispatcher prompt contains only top 20 by count", async () => {
    // Build 30 entries with descending counts so sort selects top 20 cleanly.
    const intents = Array.from({ length: 30 }, (_, i) => ({
      intent: `i${String(i).padStart(2, "0")}`,
      count: 100 - i, // i00=100 (highest), i29=71 (lowest in top 20 cutoff)
    }));
    // Build a canned 20-entry response.
    const canned20 = JSON.stringify(
      Array.from({ length: 20 }, (_, i) => ({
        intent: `i${String(i).padStart(2, "0")}`,
        prompt: `prompt for i${String(i).padStart(2, "0")}`,
      })),
    );
    const dispatch = vi.fn<SynthesizerDeps["dispatcher"]["dispatch"]>(async () => canned20);
    const outcome = await synthesizeCanaryPrompts(
      baseDeps({
        topIntents: intents,
        limit: 20,
        dispatcher: {
          dispatch:
            dispatch as unknown as SynthesizerDeps["dispatcher"]["dispatch"],
        },
      }),
    );

    expect(outcome.kind).toBe("synthesized");
    if (outcome.kind === "synthesized") {
      expect(outcome.prompts).toHaveLength(20);
    }
    // The dispatcher prompt should contain top 20 intents (i00..i19) and NOT
    // the lowest-count entries that fell outside the slice (i20..i29).
    // Index [2] = message arg per SynthesizerDispatchFn signature.
    const promptArg = dispatch.mock.calls[0]?.[2] ?? "";
    expect(promptArg).toContain("i00");
    expect(promptArg).toContain("i19");
    expect(promptArg).not.toContain("i29");
    expect(promptArg).not.toContain("i25");
  });
});

describe("synthesizeCanaryPrompts — S3 no intents", () => {
  it("empty topIntents → outcome.kind === 'no-intents' and dispatcher NEVER called", async () => {
    const dispatch = vi.fn();
    const outcome = await synthesizeCanaryPrompts(
      baseDeps({
        topIntents: [],
        dispatcher: {
          dispatch:
            dispatch as unknown as SynthesizerDeps["dispatcher"]["dispatch"],
        },
      }),
    );
    expect(outcome.kind).toBe("no-intents");
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("synthesizeCanaryPrompts — S4 schema mismatch", () => {
  it("dispatcher returns object missing intent/prompt → schema-validation-failed", async () => {
    const dispatch = vi.fn(async () => JSON.stringify([{ foo: "bar" }]));
    const outcome = await synthesizeCanaryPrompts(
      baseDeps({
        dispatcher: {
          dispatch:
            dispatch as unknown as SynthesizerDeps["dispatcher"]["dispatch"],
        },
      }),
    );
    expect(outcome.kind).toBe("schema-validation-failed");
    if (outcome.kind === "schema-validation-failed") {
      expect(outcome.error.length).toBeGreaterThan(0);
      expect(outcome.rawResponse).toContain("foo");
    }
  });
});
