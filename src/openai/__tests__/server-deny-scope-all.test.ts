/**
 * Phase 74 Plan 02 — server-side tests for the `security.denyScopeAll` gate.
 *
 * When body.model matches a ClawCode-native agent AND that agent's resolved
 * config has `security.denyScopeAll: true` AND the bearer row.scope === "all",
 * handleChatCompletions returns 403 permission_error with
 * code='agent_forbids_multi_agent_key'. The `openclaw:*` template-driver path
 * is explicitly NOT subject to this check (that branch has no native agent
 * target — the slug is caller-controlled).
 *
 * Complements server-openclaw-routing.test.ts (which proves the template
 * branch is reachable) with 9 tests that pin the per-agent gate behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  startOpenAiServer,
  type OpenAiServerHandle,
  type OpenAiSessionDriver,
} from "../server.js";
import { ApiKeysStore } from "../keys.js";
import type { SdkStreamEvent } from "../types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function textEvents(text: string, sessionId: string): SdkStreamEvent[] {
  return [
    {
      type: "stream_event",
      event: {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text" },
      },
    },
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
    },
    { type: "result", session_id: sessionId },
  ];
}

interface SpyDriver extends OpenAiSessionDriver {
  readonly calls: Array<Parameters<OpenAiSessionDriver["dispatch"]>[0]>;
}

function makeSpyDriver(events: SdkStreamEvent[]): SpyDriver {
  const calls: Array<Parameters<OpenAiSessionDriver["dispatch"]>[0]> = [];
  return {
    calls,
    async *dispatch(input) {
      calls.push(input);
      for (const e of events) yield e;
    },
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type AgentConfigLookup = (name: string) =>
  | { security?: { denyScopeAll?: boolean } }
  | null
  | undefined;

interface Harness {
  handle: OpenAiServerHandle;
  baseUrl: string;
  keysStore: ApiKeysStore;
  nativeDriver: SpyDriver;
  templateDriver: SpyDriver;
  pinnedKey: string;
  allKey: string;
  agentNames: string[];
}

async function bootHarness(getAgentConfig: AgentConfigLookup): Promise<Harness> {
  const agentNames = ["protected-agent", "normal-agent", "admin-clawdy"];
  const keysStore = new ApiKeysStore(":memory:");
  const { key: pinnedKey } = keysStore.createKey("protected-agent", {
    label: "pinned-protected",
  });
  const { key: allKey } = keysStore.createAllKey({ label: "fleet-all" });

  const nativeDriver = makeSpyDriver(textEvents("native-output", "sess-native"));
  const templateDriver = makeSpyDriver(
    textEvents("template-output", "sess-template"),
  );

  const handle = await startOpenAiServer({
    port: 0,
    host: "127.0.0.1",
    maxRequestBodyBytes: 1 * 1024 * 1024,
    streamKeepaliveMs: 15_000,
    apiKeysStore: keysStore,
    driver: nativeDriver,
    templateDriver,
    agentNames: () => agentNames,
    getAgentConfig,
  });

  return {
    handle,
    baseUrl: `http://127.0.0.1:${handle.address.port}`,
    keysStore,
    nativeDriver,
    templateDriver,
    pinnedKey,
    allKey,
    agentNames,
  };
}

async function teardown(h: Harness): Promise<void> {
  await h.handle.close();
  h.keysStore.close();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("server security.denyScopeAll gate — Phase 74 Plan 02", () => {
  let h: Harness | null = null;

  afterEach(async () => {
    if (h) {
      await teardown(h);
      h = null;
    }
  });

  it("Test 5: scope='all' + denyScopeAll=true → 403 permission_error + agent_forbids_multi_agent_key", async () => {
    h = await bootHarness((name) =>
      name === "protected-agent" ? { security: { denyScopeAll: true } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "protected-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.type).toBe("permission_error");
    expect(body.error.code).toBe("agent_forbids_multi_agent_key");
    expect(body.error.message).toMatch(/multi-agent/i);
    expect(h.nativeDriver.calls.length).toBe(0);
    expect(h.templateDriver.calls.length).toBe(0);
  });

  it("Test 6: scope='all' + denyScopeAll=false → driver.dispatch called (200 success)", async () => {
    h = await bootHarness((name) =>
      name === "protected-agent" ? { security: { denyScopeAll: false } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "protected-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
    expect(h.nativeDriver.calls[0]!.agentName).toBe("protected-agent");
  });

  it("Test 7: scope='all' + getAgentConfig returns null → driver.dispatch called (default permissive)", async () => {
    h = await bootHarness(() => null);
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "protected-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
  });

  it("Test 8: pinned key (scope='agent:protected-agent') + denyScopeAll=true → 200 (flag only gates scope='all')", async () => {
    h = await bootHarness((name) =>
      name === "protected-agent" ? { security: { denyScopeAll: true } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "protected-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
    expect(h.templateDriver.calls.length).toBe(0);
  });

  it("Test 9: openclaw:<slug>:<tier> + scope='all' bearer bypasses denyScopeAll even if native agent 'admin-clawdy' has it set", async () => {
    h = await bootHarness((name) =>
      name === "admin-clawdy" ? { security: { denyScopeAll: true } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:admin-clawdy:opus",
        messages: [
          { role: "system", content: "SOUL" },
          { role: "user", content: "hi" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    // openclaw: path MUST route to template driver, NOT native, AND the
    // denyScopeAll gate must NOT fire on the openclaw-template branch.
    expect(h.templateDriver.calls.length).toBe(1);
    expect(h.nativeDriver.calls.length).toBe(0);
  });

  it("denyScopeAll gate only fires when scope='all' — pinned key on a DIFFERENT agent gets normal 403 agent_mismatch (not agent_forbids_multi_agent_key)", async () => {
    h = await bootHarness((name) =>
      name === "normal-agent" ? { security: { denyScopeAll: true } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // pinnedKey is bound to protected-agent, NOT normal-agent.
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "normal-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("agent_mismatch");
    // Ensure denyScopeAll gate did NOT fire:
    expect(body.error.code).not.toBe("agent_forbids_multi_agent_key");
  });

  it("scope='all' targeting a DIFFERENT agent (without the flag) succeeds while another agent has it set", async () => {
    // One agent (protected-agent) blocked; another (normal-agent) permissive.
    h = await bootHarness((name) =>
      name === "protected-agent" ? { security: { denyScopeAll: true } } : null,
    );
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "normal-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
    expect(h.nativeDriver.calls[0]!.agentName).toBe("normal-agent");
  });

  it("server without getAgentConfig configured → denyScopeAll check is no-op (Phase 69 backwards-compat)", async () => {
    // Boot WITHOUT passing getAgentConfig at all — optional field.
    const agentNames = ["protected-agent", "normal-agent"];
    const keysStore = new ApiKeysStore(":memory:");
    const { key: allKey } = keysStore.createAllKey({ label: "fleet" });
    const nativeDriver = makeSpyDriver(textEvents("ok", "sess-1"));
    const handle = await startOpenAiServer({
      port: 0,
      host: "127.0.0.1",
      maxRequestBodyBytes: 1 * 1024 * 1024,
      streamKeepaliveMs: 15_000,
      apiKeysStore: keysStore,
      driver: nativeDriver,
      agentNames: () => agentNames,
      // getAgentConfig deliberately omitted
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${handle.address.port}/v1/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${allKey}`,
          },
          body: JSON.stringify({
            model: "protected-agent",
            messages: [{ role: "user", content: "hi" }],
          }),
        },
      );
      expect(res.status).toBe(200);
      expect(nativeDriver.calls.length).toBe(1);
    } finally {
      await handle.close();
      keysStore.close();
    }
  });

  it("getAgentConfig returns { security: undefined } → gate treats it as denyScopeAll=false (permissive)", async () => {
    h = await bootHarness(() => ({ security: undefined }));
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "protected-agent",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
  });
});
