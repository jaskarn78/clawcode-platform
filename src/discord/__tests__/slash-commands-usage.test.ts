/**
 * Phase 103 OBS-07 — /clawcode-usage handler integration tests.
 *
 * Verifies the IPC dispatch + embed-render contract end-to-end without
 * standing up a Discord client. The inline handler in slash-commands.ts
 * must:
 *   1. Defer the reply (or no-op if already deferred)
 *   2. Call IPC `list-rate-limit-snapshots` with {agent}
 *   3. Pass the resulting snapshots[] verbatim into buildUsageEmbed
 *   4. editReply({embeds: [embed]}) with the result
 *
 * These tests cover the IPC↔embed glue: the daemon handler returns
 * `{agent, snapshots: RateLimitSnapshot[]}` and buildUsageEmbed accepts
 * that payload directly.
 */
import { describe, it, expect } from "vitest";
import { buildUsageEmbed } from "../usage-embed.js";
import { handleListRateLimitSnapshotsIpc } from "../../manager/daemon-rate-limit-ipc.js";
import type { RateLimitSnapshot } from "../../usage/rate-limit-tracker.js";

describe("/clawcode-usage handler integration (OBS-07)", () => {
  it("buildUsageEmbed accepts the IPC response shape directly", () => {
    // The IPC handler returns { agent, snapshots: RateLimitSnapshot[] }.
    // The inline handler in slash-commands.ts passes snapshots through
    // unmodified — so the IPC response shape MUST be byte-compatible
    // with BuildUsageEmbedInput.snapshots.
    const ipcResponse = {
      agent: "test-agent",
      snapshots: [
        Object.freeze({
          rateLimitType: "five_hour",
          status: "allowed" as const,
          utilization: 0.42,
          resetsAt: Date.now() + 3_600_000,
          surpassedThreshold: undefined,
          overageStatus: undefined,
          overageResetsAt: undefined,
          overageDisabledReason: undefined,
          isUsingOverage: undefined,
          recordedAt: Date.now(),
        }) satisfies RateLimitSnapshot,
      ],
    };

    const embed = buildUsageEmbed({
      agent: ipcResponse.agent,
      snapshots: ipcResponse.snapshots,
      now: Date.now(),
    });

    expect(embed.data.title).toBe("📊 Usage — test-agent");
    expect(embed.data.fields?.[0]?.name).toContain("5-hour session");
  });

  it("handles empty IPC snapshots array gracefully", () => {
    // Pitfall 7 — when the agent has no UsageTracker (memoryEnabled=false)
    // OR no rate_limit_event has fired yet, the IPC returns
    // {agent, snapshots: []}. The embed must still render (no throw).
    const ipcResponse = handleListRateLimitSnapshotsIpc(
      { agent: "no-such-agent" },
      { getRateLimitTrackerForAgent: () => undefined },
    );
    const embed = buildUsageEmbed({
      agent: ipcResponse.agent,
      snapshots: ipcResponse.snapshots,
      now: Date.now(),
    });
    expect(embed.data.description).toContain("No usage data yet");
  });

  it("end-to-end: seeded tracker → IPC → embed renders 5h bar", () => {
    const seeded: RateLimitSnapshot = Object.freeze({
      rateLimitType: "five_hour",
      status: "allowed_warning",
      utilization: 0.85,
      resetsAt: Date.now() + 1_800_000,
      surpassedThreshold: undefined,
      overageStatus: undefined,
      overageResetsAt: undefined,
      overageDisabledReason: undefined,
      isUsingOverage: undefined,
      recordedAt: Date.now(),
    });
    const ipcResponse = handleListRateLimitSnapshotsIpc(
      { agent: "fin" },
      {
        getRateLimitTrackerForAgent: (name) =>
          name === "fin" ? { getAllSnapshots: () => [seeded] } : undefined,
      },
    );
    const embed = buildUsageEmbed({
      agent: ipcResponse.agent,
      snapshots: ipcResponse.snapshots,
      now: Date.now(),
    });
    // allowed_warning → yellow
    expect(embed.data.color).toBe(15844367);
    expect(embed.data.fields?.[0]?.name).toContain("5-hour session");
    expect(embed.data.fields?.[0]?.value).toContain("85%");
  });
});
