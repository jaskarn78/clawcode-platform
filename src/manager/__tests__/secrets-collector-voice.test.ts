/**
 * Phase 135 Plan 01 Task 2 — secrets-collector Zone 5 (voice keys).
 *
 * Pins three behaviors the boot path depends on:
 *
 *   1. Agent with op:// voice.deepgramKey + op:// voice.elevenLabsKey →
 *      both refs land in the resolver-warmup set.
 *   2. Agent with literal-string voice keys (not op://) → no refs added.
 *      (Matches Zones 1–4 behavior: only op:// refs warm the cache.)
 *   3. Agent without a voice block → no refs from that agent.
 *
 * The collector returns insertion-order array of unique URIs; the test
 * uses `Set` semantics (membership only) to remain robust to ordering
 * shifts between Zone walks.
 */
import { describe, it, expect } from "vitest";
import type { Config } from "../../config/schema.js";
import { collectAllOpRefs } from "../secrets-collector.js";

/**
 * Cast helper — the tests build minimal Config-shaped objects that
 * satisfy ONLY the zones under test. Properly-shaped Config requires a
 * full agent block + defaults + discord; that's out of scope here.
 */
function asConfig(obj: unknown): Config {
  return obj as Config;
}

describe("secrets-collector Zone 5 — Phase 135 Plan 01 Task 2", () => {
  it("adds both op:// voice keys for an agent with a voice block", () => {
    const refs = collectAllOpRefs(asConfig({
      agents: [
        {
          name: "voice-agent",
          voice: {
            deepgramKey: "op://example-vault/dg/key",
            elevenLabsKey: "op://example-vault/el/key",
            voiceId: "voice-id-1",
          },
        },
      ],
    }));
    const set = new Set(refs);
    expect(set.has("op://example-vault/dg/key")).toBe(true);
    expect(set.has("op://example-vault/el/key")).toBe(true);
  });

  it("ignores literal-string voice keys (no op:// prefix)", () => {
    const refs = collectAllOpRefs(asConfig({
      agents: [
        {
          name: "literal-agent",
          voice: {
            deepgramKey: "literal-key-not-op",
            elevenLabsKey: "another-literal-key",
            voiceId: "voice-id-1",
          },
        },
      ],
    }));
    const set = new Set(refs);
    expect(set.has("literal-key-not-op")).toBe(false);
    expect(set.has("another-literal-key")).toBe(false);
    expect(refs.length).toBe(0);
  });

  it("returns an empty set for an agent without a voice block", () => {
    const refs = collectAllOpRefs(asConfig({
      agents: [{ name: "text-only-agent" }],
    }));
    expect(refs.length).toBe(0);
  });

  it("deduplicates the same op:// ref appearing in two agents", () => {
    const refs = collectAllOpRefs(asConfig({
      agents: [
        {
          name: "agent-a",
          voice: {
            deepgramKey: "op://example-vault/shared-dg",
            elevenLabsKey: "op://example-vault/el-a",
            voiceId: "voice-id-a",
          },
        },
        {
          name: "agent-b",
          voice: {
            deepgramKey: "op://example-vault/shared-dg", // same as agent-a
            elevenLabsKey: "op://example-vault/el-b",
            voiceId: "voice-id-b",
          },
        },
      ],
    }));
    // 3 distinct refs: shared-dg + el-a + el-b
    expect(refs.length).toBe(3);
    expect(new Set(refs).has("op://example-vault/shared-dg")).toBe(true);
  });

  it("mixes voice refs with other-zone refs without losing any", () => {
    const refs = collectAllOpRefs(asConfig({
      discord: { botToken: "op://example-vault/discord/token" },
      agents: [
        {
          name: "agent",
          voice: {
            deepgramKey: "op://example-vault/dg/key",
            elevenLabsKey: "op://example-vault/el/key",
            voiceId: "voice-id-1",
          },
        },
      ],
    }));
    const set = new Set(refs);
    expect(set.has("op://example-vault/discord/token")).toBe(true); // Zone 1
    expect(set.has("op://example-vault/dg/key")).toBe(true);        // Zone 5
    expect(set.has("op://example-vault/el/key")).toBe(true);        // Zone 5
  });
});
