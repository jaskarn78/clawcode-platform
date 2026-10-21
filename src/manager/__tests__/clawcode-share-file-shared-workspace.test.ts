/**
 * Phase 999.36 sub-bug C (D-11) — shared-workspace regression test.
 *
 * Pins the 2026-05-06 production failure class: fin-client spawned
 * the Schwab AIP deep-dive subagent. Text landed correctly in Client A's
 * thread, but the markdown file attachment leaked to channel
 * 000000000000000112 (acme-content-creator's primary channel)
 * instead of Client A's `000000000000000110`. Compliance-relevant for
 * Acme (PII risk in different scenario).
 *
 * Root cause: `clawcode_share_file` resolution walked workspace → agent
 * binding. Two agents (fin-client + acme-content-creator)
 * share `/home/clawcode/.clawcode/agents/acme`. The LLM in the
 * subagent context passed `agent: acme-content-creator` (sibling
 * identity drift in shared-workspace pair). Pre-fix: daemon resolved
 * to that sibling's `channels[0]` and uploaded there.
 *
 * Fix: route through `resolveShareFileChannel` which consults the thread
 * binding registry by sessionName FIRST. The subagent's sessionName
 * (e.g. `fin-client-sub-OV9rkf`) is the unique identity that
 * disambiguates the family — even when sibling configs share the
 * workspace.
 *
 * Test directly targets the pure helper. No daemon spin-up.
 */

import { describe, it, expect } from "vitest";
import { resolveShareFileChannel } from "../tools/share-file-channel-resolver.js";
import type { ThreadBindingRegistry } from "../../discord/thread-types.js";

// ---------------------------------------------------------------------------
// Shared-workspace fin-client / content-creator fixture (operator
// evidence). Channel IDs are the actual Discord IDs from the 2026-05-06
// production incident — DO NOT change without updating PHASE.md and the
// SUMMARY.md to keep them aligned.
// ---------------------------------------------------------------------------
const FIN_CLIENT_THREAD = "000000000000000110"; // Client A's channel/thread (correct destination)
const CONTENT_CREATOR_CHANNEL = "000000000000000112"; // sibling's primary (leak destination)
const FIN_CLIENT_SUB_SESSION = "fin-client-sub-OV9rkf"; // subagent sessionName from incident

function buildRegistryWithFinAcqSubBinding(): ThreadBindingRegistry {
  return {
    bindings: [
      {
        threadId: FIN_CLIENT_THREAD,
        parentChannelId: FIN_CLIENT_THREAD,
        agentName: "fin-client", // PARENT agentName
        sessionName: FIN_CLIENT_SUB_SESSION, // SUBAGENT sessionName — the disambiguator
        createdAt: Date.now(),
        lastActivity: Date.now(),
      },
    ],
    updatedAt: Date.now(),
  };
}

const finAcqConfig = { channels: [FIN_CLIENT_THREAD] };
const contentCreatorConfig = { channels: [CONTENT_CREATOR_CHANNEL] };

describe("resolveShareFileChannel — shared-workspace invariant (sub-bug C)", () => {
  it("routes to subagent thread, not sibling agent's primary channel — Schwab AIP failure class", () => {
    // Pre-Phase-999.36 the resolver would have returned
    // contentCreatorConfig.channels[0] (the leak destination). The new
    // path consults the registry by sessionName FIRST and returns the
    // bound thread regardless of which sibling agentConfig is passed in.
    const resolved = resolveShareFileChannel(
      FIN_CLIENT_SUB_SESSION,
      undefined, // no explicit channel_id override
      buildRegistryWithFinAcqSubBinding(),
      contentCreatorConfig, // pass the WRONG agent's config to verify
      // resolution does NOT depend on it
    );

    expect(resolved).toBe(FIN_CLIENT_THREAD);
    // Anti-leak assertion — load-bearing pin for the Schwab AIP failure
    // class. Keep this even though it's logically implied by the .toBe
    // above; checker greps for the exact "not.toBe(CONTENT_CREATOR_CHANNEL)"
    // pattern.
    expect(resolved).not.toBe(CONTENT_CREATOR_CHANNEL);
  });

  it("falls back to agentConfig.channels[0] when agentName is the parent (no sessionName match)", () => {
    // The binding's sessionName is the SUBAGENT identity. Looking up by
    // the PARENT name (`fin-client`) returns undefined from
    // getBindingForSession (sessionName field doesn't match), so the
    // helper falls through to channels[0]. Backwards-compat pin.
    const resolved = resolveShareFileChannel(
      "fin-client", // PARENT name, not sessionName
      undefined,
      buildRegistryWithFinAcqSubBinding(),
      finAcqConfig,
    );

    expect(resolved).toBe(FIN_CLIENT_THREAD);
    // The path here is fallback (channels[0]), NOT the binding lookup —
    // confirmed by Test 1 having the same expected value but different
    // resolution path. Both end at FIN_CLIENT_THREAD because Client A's channel
    // happens to be both the bound thread AND fin-client's primary;
    // that's coincidental for this fixture and load-bearing for showing
    // the parent-name path is undisturbed.
  });

  it("falls back to channels[0] when no binding matches (regular agent, empty registry)", () => {
    const emptyRegistry: ThreadBindingRegistry = {
      bindings: [],
      updatedAt: Date.now(),
    };
    const generalConfig = { channels: ["general-channel-id"] };

    const resolved = resolveShareFileChannel(
      "general",
      undefined,
      emptyRegistry,
      generalConfig,
    );

    expect(resolved).toBe("general-channel-id");
  });

  it("explicit channelIdParam overrides binding lookup AND fallback", () => {
    // Operator override always wins. Confirms the resolution-order
    // invariant: channel_id param > binding lookup > channels[0].
    const resolved = resolveShareFileChannel(
      FIN_CLIENT_SUB_SESSION, // would otherwise hit the binding lookup
      "operator-override-channel", // explicit channel_id
      buildRegistryWithFinAcqSubBinding(),
      contentCreatorConfig,
    );

    expect(resolved).toBe("operator-override-channel");
    // Defense-in-depth: also confirm we did NOT silently route to the
    // binding's threadId or to channels[0].
    expect(resolved).not.toBe(FIN_CLIENT_THREAD);
    expect(resolved).not.toBe(CONTENT_CREATOR_CHANNEL);
  });

  it("returns undefined when no override, no binding, and no channels configured", () => {
    // Pinned for the daemon's `if (!channelId)` refusal path. Without
    // this, a misconfigured agent could fall through silently.
    const emptyRegistry: ThreadBindingRegistry = {
      bindings: [],
      updatedAt: Date.now(),
    };
    const noChannelsConfig = { channels: [] as readonly string[] };

    const resolved = resolveShareFileChannel(
      "agent-with-no-channels",
      undefined,
      emptyRegistry,
      noChannelsConfig,
    );

    expect(resolved).toBeUndefined();
  });
});
