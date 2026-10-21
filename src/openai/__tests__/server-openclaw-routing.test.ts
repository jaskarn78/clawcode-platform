/**
 * Phase 74 Plan 01 — Integration tests for caller-identity routing in server.ts.
 *
 * Boots a real node:http server with BOTH a mock native `driver` AND a mock
 * `templateDriver`. Asserts:
 *   - body.model='test-agent' (literal) → native driver only
 *   - body.model='openclaw:fin-test:sonnet' + scope='all' → template driver only
 *   - body.model='openclaw:fin-test' (no tier) → template driver, tier=sonnet
 *   - malformed openclaw: model → 400 malformed_caller
 *   - openclaw: model with pinned key → 400 malformed_caller (NOT 403)
 *   - unknown literal model → 404 unknown_model
 *   - Phase 69 auth-level errors (401, 400) still fire before caller-identity
 *   - Non-streaming shape: response.model echoes the REQUESTED id
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { startOpenAiServer, type OpenAiServerHandle, type OpenAiSessionDriver } from "../server.js";
import { ApiKeysStore } from "../keys.js";
import type { SdkStreamEvent, TemplateDriverInput } from "../types.js";

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

async function bootHarness(): Promise<Harness> {
  const agentNames = ["fin-test", "test-agent", "admin-clawdy"];
  const keysStore = new ApiKeysStore(":memory:");
  const { key: pinnedKey } = keysStore.createKey("test-agent", { label: "pinned" });
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

describe("server caller-identity routing — Phase 74 Plan 01", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await bootHarness();
  });
  afterEach(async () => {
    await teardown(h);
  });

  it("Test 1: literal agent name routes to native driver only", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "test-agent",
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.nativeDriver.calls.length).toBe(1);
    expect(h.templateDriver.calls.length).toBe(0);
    expect(h.nativeDriver.calls[0]!.agentName).toBe("test-agent");
  });

  it("Test 2: openclaw:<slug>:<tier> with scope='all' routes to template driver only", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:fin-test:sonnet",
        messages: [
          { role: "system", content: "CUSTOM SOUL" },
          { role: "user", content: "hello" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.templateDriver.calls.length).toBe(1);
    expect(h.nativeDriver.calls.length).toBe(0);
    const templateCall = h.templateDriver.calls[0] as unknown as TemplateDriverInput;
    expect(templateCall.callerSlug).toBe("fin-test");
    expect(templateCall.tier).toBe("sonnet");
    expect(templateCall.soulPrompt).toBe("CUSTOM SOUL");
    expect(templateCall.agentName).toBe("openclaw:fin-test");
  });

  it("Test 3: openclaw:<slug> (no tier) defaults to sonnet", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:fin-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(h.templateDriver.calls.length).toBe(1);
    const templateCall = h.templateDriver.calls[0] as unknown as TemplateDriverInput;
    expect(templateCall.tier).toBe("sonnet");
  });

  it("Test 4: malformed openclaw: slug → 400 malformed_caller", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:/bad/",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("malformed_caller");
    expect(h.nativeDriver.calls.length).toBe(0);
    expect(h.templateDriver.calls.length).toBe(0);
  });

  it("Test 5: pinned key (scope=agent:<name>) attempting openclaw route → 400 malformed_caller", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.pinnedKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:fin-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("malformed_caller");
    expect(h.nativeDriver.calls.length).toBe(0);
    expect(h.templateDriver.calls.length).toBe(0);
  });

  it("Test 6: totally unknown non-prefixed model → 404 unknown_model (Phase 69 surface preserved)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "totally-unknown-thing",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("unknown_model");
  });

  it("Test 7a: Phase 69 auth errors still fire — missing bearer → 401", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "openclaw:fin-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("missing_key");
  });

  it("Test 7b: invalid bearer → 401 invalid_key (before caller-identity)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer ck_bogus_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      },
      body: JSON.stringify({
        model: "openclaw:fin-test",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_key");
  });

  it("Test 7c: body-parse error → 400 body_parse_error (before caller-identity)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: "{not valid json",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("body_parse_error");
  });

  it("Test 8: non-streaming response.model echoes the REQUESTED id, not the translated model", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:fin-test:sonnet",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      id: string;
      object: string;
      model: string;
      choices: Array<{ message: { role: string; content: string | null } }>;
    };
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("openclaw:fin-test:sonnet");
    expect(body.id).toMatch(/^chatcmpl-/);
    expect(body.choices[0]!.message.role).toBe("assistant");
  });

  it("openclaw:<slug>:opus maps tier correctly on the driver call", async () => {
    const res = await fetch(`${h.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${h.allKey}`,
      },
      body: JSON.stringify({
        model: "openclaw:researcher:opus",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(res.status).toBe(200);
    const templateCall = h.templateDriver.calls[0] as unknown as TemplateDriverInput;
    expect(templateCall.tier).toBe("opus");
    expect(templateCall.callerSlug).toBe("researcher");
  });

  it("returns 501 template_driver_disabled when no templateDriver wired AND openclaw: model used", async () => {
    // Fresh boot without templateDriver.
    const agentNames = ["fin-test"];
    const keysStore = new ApiKeysStore(":memory:");
    const { key: allKey } = keysStore.createAllKey({ label: "fleet" });
    const nativeDriver = makeSpyDriver(textEvents("x", "s"));
    const handle = await startOpenAiServer({
      port: 0,
      host: "127.0.0.1",
      maxRequestBodyBytes: 1 * 1024 * 1024,
      streamKeepaliveMs: 15_000,
      apiKeysStore: keysStore,
      driver: nativeDriver,
      // templateDriver deliberately omitted
      agentNames: () => agentNames,
    });
    try {
      const res = await fetch(`http://127.0.0.1:${handle.address.port}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${allKey}`,
        },
        body: JSON.stringify({
          model: "openclaw:some-slug",
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      expect(res.status).toBe(501);
      const body = await res.json();
      expect(body.error.code).toBe("template_driver_disabled");
      expect(nativeDriver.calls.length).toBe(0);
    } finally {
      await handle.close();
      keysStore.close();
    }
  });
});
