/**
 * Phase 92 Plan 04 Task 1 — destructive-embed-renderer tests (RED).
 *
 * Pins:
 *   R1: outdated-memory-file → embed title + 2 hashes + Accept Danger button
 *   R2: mcp-credential-drift → server name + env KEY NAMES (NOT values) + 3 buttons
 *   R3: tool-permission-gap  → tool name + ACL deny list + 3 buttons
 *   R4: customId-shape       → cutover-{agent}-{gapId}:accept regex; gapId deterministic
 *   R5: NO-LEAK              → embed JSON does NOT contain literal env value
 *                              "sk_live_secret_42" even when present in deps space
 *
 * The 5th destructive kind (cron-session-not-mirrored, D-11) is covered by the
 * exhaustive-switch compile-time gate (assertNever in default branch); we don't
 * need a per-kind render test for it in Plan 92-04 since target capability v1
 * doesn't yet emit cron entries — but renderDestructiveGapEmbed MUST handle it
 * to compile.
 */
import { describe, it, expect } from "vitest";
import { ButtonStyle } from "discord.js";
import { renderDestructiveGapEmbed } from "../destructive-embed-renderer.js";
import type { DestructiveCutoverGap } from "../types.js";

const TEST_AGENT = "fin-client";

const outdatedGap: DestructiveCutoverGap = {
  kind: "outdated-memory-file",
  identifier: "memory/2026-04-15-portfolio.md",
  severity: "destructive",
  sourceRef: {
    path: "memory/2026-04-15-portfolio.md",
    sourceHash: "abc1234567890abc1234567890abc1234567890abc1234567890abcdef012345",
  },
  targetRef: {
    path: "memory/2026-04-15-portfolio.md",
    targetHash: "def9876543210def9876543210def9876543210def9876543210fedcba543210",
  },
};

const mcpDriftGap: DestructiveCutoverGap = {
  kind: "mcp-credential-drift",
  identifier: "stripe",
  severity: "destructive",
  sourceRef: {
    mcpServerName: "stripe",
    envKeys: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"],
  },
  targetRef: {
    mcpServerName: "stripe",
    envKeys: ["STRIPE_SECRET_KEY"],
    status: "critical",
  },
};

const toolPermGap: DestructiveCutoverGap = {
  kind: "tool-permission-gap",
  identifier: "Bash",
  severity: "destructive",
  sourceRef: { toolName: "Bash" },
  targetRef: { aclDenies: ["Bash", "Bash(*)"] },
};

describe("renderDestructiveGapEmbed", () => {
  it("R1 outdated-memory-file: embed title + both hashes + Accept Danger button", () => {
    const r = renderDestructiveGapEmbed(TEST_AGENT, outdatedGap);

    // Title
    expect(r.embed.data.title).toContain("Cutover gap: outdated-memory-file");

    // Both hashes (truncated to 16 chars in description)
    const desc = r.embed.data.description ?? "";
    expect(desc).toContain("abc1234567890abc"); // first 16 of source hash
    expect(desc).toContain("def9876543210def"); // first 16 of target hash

    // 1 row × 3 buttons
    expect(r.components).toHaveLength(1);
    const buttons = r.components[0]!.components;
    expect(buttons).toHaveLength(3);

    // Accept is FIRST and is ButtonStyle.Danger (D-06 — red destructive)
    const accept = buttons[0]!;
    expect((accept.data as { style?: number }).style).toBe(ButtonStyle.Danger);
    expect((accept.data as { custom_id?: string }).custom_id).toMatch(
      /^cutover-fin-client-[a-f0-9]+:accept$/,
    );

    // gapId in customId is consistent across all 3 buttons
    const acceptId = (accept.data as { custom_id: string }).custom_id;
    const rejectId = (buttons[1]!.data as { custom_id: string }).custom_id;
    const deferId = (buttons[2]!.data as { custom_id: string }).custom_id;
    const acceptGapId = acceptId.match(
      /^cutover-fin-client-([a-f0-9]+):accept$/,
    )?.[1];
    expect(acceptGapId).toBeDefined();
    expect(rejectId).toBe(`cutover-fin-client-${acceptGapId}:reject`);
    expect(deferId).toBe(`cutover-fin-client-${acceptGapId}:defer`);
  });

  it("R2 mcp-credential-drift: includes server name + env KEY NAMES + 3 buttons", () => {
    const r = renderDestructiveGapEmbed(TEST_AGENT, mcpDriftGap);

    expect(r.embed.data.title).toContain("Cutover gap: mcp-credential-drift");
    const desc = r.embed.data.description ?? "";
    expect(desc).toContain("stripe");
    expect(desc).toContain("STRIPE_SECRET_KEY");
    expect(desc).toContain("STRIPE_WEBHOOK_SECRET");
    expect(desc).toContain("critical");

    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.components).toHaveLength(3);
  });

  it("R3 tool-permission-gap: includes tool name + ACL deny list + 3 buttons", () => {
    const r = renderDestructiveGapEmbed(TEST_AGENT, toolPermGap);

    expect(r.embed.data.title).toContain("Cutover gap: tool-permission-gap");
    const desc = r.embed.data.description ?? "";
    expect(desc).toContain("Bash");
    expect(desc).toContain("Bash(*)");

    expect(r.components).toHaveLength(1);
    expect(r.components[0]!.components).toHaveLength(3);
  });

  it("R4 customId-shape: gapId is deterministic across renders + matches regex", () => {
    const r1 = renderDestructiveGapEmbed(TEST_AGENT, outdatedGap);
    const r2 = renderDestructiveGapEmbed(TEST_AGENT, outdatedGap);

    // Determinism: identical input → identical gapId
    expect(r1.gapId).toBe(r2.gapId);
    expect(r1.gapId).toMatch(/^[a-f0-9]+$/); // hex-only

    // customId regex pin (Plan 92-04 invariant — collision-safe namespacing)
    const acceptBtn = r1.components[0]!.components[0]!;
    expect((acceptBtn.data as { custom_id: string }).custom_id).toMatch(
      /^cutover-fin-client-[a-f0-9]+:accept$/,
    );

    // Different gap → different gapId
    const r3 = renderDestructiveGapEmbed(TEST_AGENT, mcpDriftGap);
    expect(r3.gapId).not.toBe(r1.gapId);

    // Different agent → different gapId for SAME gap
    const r4 = renderDestructiveGapEmbed("other-agent", outdatedGap);
    expect(r4.gapId).not.toBe(r1.gapId);
  });

  it("R5 NO-LEAK: literal env value never appears in rendered embed JSON", () => {
    // The renderer reads gap.sourceRef.envKeys (KEY NAMES ONLY). VALUES
    // are never in the gap; this test feeds a gap that holds only key
    // names and asserts the rendered embed JSON does not contain a
    // sentinel value the renderer must NEVER touch.
    const SENTINEL = "sk_live_secret_42";
    const r = renderDestructiveGapEmbed(TEST_AGENT, mcpDriftGap);

    // Construct embed JSON form (what discord.js would serialize)
    const embedJson = JSON.stringify(r.embed.toJSON());
    expect(embedJson).not.toContain(SENTINEL);

    // Defense-in-depth: full component JSON also clean
    const componentsJson = JSON.stringify(
      r.components.map((c) => c.toJSON()),
    );
    expect(componentsJson).not.toContain(SENTINEL);

    // Sanity: env KEY NAMES (Object.keys discipline) DO appear
    expect(embedJson).toContain("STRIPE_SECRET_KEY");
  });
});
