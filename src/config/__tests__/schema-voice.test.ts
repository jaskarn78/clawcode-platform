/**
 * Phase 135 Plan 01 Task 2 — voiceConfigSchema parse + agentSchema.voice
 * optional-block contract.
 *
 * Pins three behaviors the Plan-02 STT/TTS wiring depends on:
 *
 *   1. A valid voice block (required + optional fields present) parses
 *      and is reachable via `agentSchema.voice`.
 *   2. Missing a required field (`deepgramKey`/`elevenLabsKey`/`voiceId`)
 *      rejects loudly at parse time — Plan 02's call sites assume these
 *      strings are non-empty.
 *   3. A bad `monthlyMinutesCap` (negative, > 100_000, non-integer)
 *      rejects — Plan 03's cost-guardrail integer comparison assumes
 *      the value is already clamped at parse.
 *   4. Absent `voice` block parses cleanly (the block is optional —
 *      voice is opt-in per agent per CONTEXT.md).
 *
 * Pattern reference: existing advisorConfigSchema tests + agentSchema
 * `advisor.optional()` contract from Phase 117.
 */
import { describe, it, expect } from "vitest";
import { agentSchema, voiceConfigSchema } from "../schema.js";

describe("voiceConfigSchema — Phase 135 Plan 01 Task 2", () => {
  const validVoice = {
    deepgramKey: "op://example-vault/dg/key",
    elevenLabsKey: "op://example-vault/el/key",
    voiceId: "voice-id-1",
  };

  it("accepts the minimum-valid voice block", () => {
    const parsed = voiceConfigSchema.parse(validVoice);
    expect(parsed.deepgramKey).toBe("op://example-vault/dg/key");
    expect(parsed.elevenLabsKey).toBe("op://example-vault/el/key");
    expect(parsed.voiceId).toBe("voice-id-1");
  });

  it("accepts every optional field at once", () => {
    const parsed = voiceConfigSchema.parse({
      ...validVoice,
      channelId: "1234567890",
      promptSuffix: "Be terse — this is being read aloud.",
      monthlyMinutesCap: 60,
    });
    expect(parsed.channelId).toBe("1234567890");
    expect(parsed.promptSuffix).toBe("Be terse — this is being read aloud.");
    expect(parsed.monthlyMinutesCap).toBe(60);
  });

  it("rejects a missing required deepgramKey", () => {
    const bad = { ...validVoice } as Record<string, unknown>;
    delete bad.deepgramKey;
    const result = voiceConfigSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects a missing required elevenLabsKey", () => {
    const bad = { ...validVoice } as Record<string, unknown>;
    delete bad.elevenLabsKey;
    expect(voiceConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required voiceId", () => {
    const bad = { ...validVoice } as Record<string, unknown>;
    delete bad.voiceId;
    expect(voiceConfigSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty-string required field", () => {
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, voiceId: "" }).success,
    ).toBe(false);
  });

  it("rejects a negative monthlyMinutesCap", () => {
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, monthlyMinutesCap: -1 }).success,
    ).toBe(false);
  });

  it("rejects monthlyMinutesCap > 100_000", () => {
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, monthlyMinutesCap: 100_001 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer monthlyMinutesCap", () => {
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, monthlyMinutesCap: 60.5 }).success,
    ).toBe(false);
  });

  it("accepts boundary monthlyMinutesCap values (1 and 100_000)", () => {
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, monthlyMinutesCap: 1 }).success,
    ).toBe(true);
    expect(
      voiceConfigSchema.safeParse({ ...validVoice, monthlyMinutesCap: 100_000 }).success,
    ).toBe(true);
  });

  // Phase 135.4 — VAD knobs.
  describe("Phase 135.4 VAD knobs", () => {
    it("accepts a mid-range utteranceEndMs", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, utteranceEndMs: 2000 }).success,
      ).toBe(true);
    });
    it("accepts a low-latency utteranceEndMs at the new 500ms floor (135.1)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, utteranceEndMs: 700 }).success,
      ).toBe(true);
    });
    it("rejects utteranceEndMs below the clamp (499)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, utteranceEndMs: 499 }).success,
      ).toBe(false);
    });
    it("rejects utteranceEndMs above the clamp (5001)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, utteranceEndMs: 5001 }).success,
      ).toBe(false);
    });
    it("accepts utteranceEndMs undefined (optional)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice }).success,
      ).toBe(true);
    });
    it("rejects a non-integer utteranceEndMs", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, utteranceEndMs: 1500.5 }).success,
      ).toBe(false);
    });

    it("accepts a mid-range endpointingMs", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, endpointingMs: 500 }).success,
      ).toBe(true);
    });
    it("rejects endpointingMs below the clamp (99)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, endpointingMs: 99 }).success,
      ).toBe(false);
    });
    it("rejects endpointingMs above the clamp (2001)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, endpointingMs: 2001 }).success,
      ).toBe(false);
    });

    it("accepts a mid-range minConfidence (0.7)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minConfidence: 0.7 }).success,
      ).toBe(true);
    });
    it("rejects negative minConfidence", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minConfidence: -0.1 }).success,
      ).toBe(false);
    });
    it("rejects minConfidence above 1", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minConfidence: 1.01 }).success,
      ).toBe(false);
    });
    it("accepts boundary minConfidence values (0 and 1)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minConfidence: 0 }).success,
      ).toBe(true);
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minConfidence: 1 }).success,
      ).toBe(true);
    });

    it("accepts a mid-range minWordCount (3)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minWordCount: 3 }).success,
      ).toBe(true);
    });
    it("rejects minWordCount below the clamp (0)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minWordCount: 0 }).success,
      ).toBe(false);
    });
    it("rejects minWordCount above the clamp (11)", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minWordCount: 11 }).success,
      ).toBe(false);
    });
    it("rejects a non-integer minWordCount", () => {
      expect(
        voiceConfigSchema.safeParse({ ...validVoice, minWordCount: 2.5 }).success,
      ).toBe(false);
    });
  });

  // Phase 135.5 — transcriptToChannel opt-in.
  describe("Phase 135.5 transcriptToChannel", () => {
    it("accepts transcriptToChannel: true", () => {
      const result = voiceConfigSchema.safeParse({
        ...validVoice,
        transcriptToChannel: true,
      });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.transcriptToChannel).toBe(true);
    });

    it("accepts transcriptToChannel: false", () => {
      const result = voiceConfigSchema.safeParse({
        ...validVoice,
        transcriptToChannel: false,
      });
      expect(result.success).toBe(true);
    });

    it("accepts transcriptToChannel undefined (optional, default-off)", () => {
      const result = voiceConfigSchema.safeParse({ ...validVoice });
      expect(result.success).toBe(true);
      if (!result.success) return;
      expect(result.data.transcriptToChannel).toBeUndefined();
    });

    it("rejects a non-boolean transcriptToChannel (string)", () => {
      expect(
        voiceConfigSchema.safeParse({
          ...validVoice,
          transcriptToChannel: "yes",
        }).success,
      ).toBe(false);
    });
  });
});

describe("agentSchema.voice — optional-block contract", () => {
  const baseAgent = {
    name: "test-agent",
    workspace: "/tmp/test-workspace",
    channels: [],
  };

  it("agent without a voice block parses cleanly (block is optional)", () => {
    const result = agentSchema.safeParse(baseAgent);
    expect(result.success).toBe(true);
  });

  it("agent WITH a valid voice block parses and exposes voice on the result", () => {
    const result = agentSchema.safeParse({
      ...baseAgent,
      voice: {
        deepgramKey: "op://example-vault/dg/key",
        elevenLabsKey: "op://example-vault/el/key",
        voiceId: "voice-id-1",
        channelId: "1234567890",
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.voice).toBeDefined();
    expect(result.data.voice?.voiceId).toBe("voice-id-1");
  });

  it("agent with an invalid voice block (missing voiceId) fails to parse", () => {
    const result = agentSchema.safeParse({
      ...baseAgent,
      voice: {
        deepgramKey: "op://example-vault/dg/key",
        elevenLabsKey: "op://example-vault/el/key",
        // missing voiceId
      },
    });
    expect(result.success).toBe(false);
  });
});
