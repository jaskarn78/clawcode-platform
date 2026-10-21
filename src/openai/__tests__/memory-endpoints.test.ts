/**
 * clawdy-v2 #8 — end-to-end tests for the /v1/memory* REST endpoints.
 *
 * Exercises the FULL path: HTTP → handleMemory (auth + routing + validation) →
 * createMemoryGateway → a real MemoryStore (`:memory:`). Covers ingest/list/
 * edit/forget round-trip, GET origin scoping (never leaks the agent's corpus),
 * idempotency, the agent-scoped-key requirement, and body validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { startOpenAiServer, type OpenAiSessionDriver } from "../server.js";
import { ApiKeysStore } from "../keys.js";
import { MemoryStore } from "../../memory/store.js";
import { createMemoryGateway } from "../../manager/openai-memory-gateway.js";

const AGENT = "personal";

// The memory routes never call the driver — a no-op async generator satisfies
// the type.
const noopDriver: OpenAiSessionDriver = {
  // eslint-disable-next-line @typescript-eslint/require-await
  async *dispatch() {
    // never invoked
  },
};

interface Harness {
  baseUrl: string;
  store: MemoryStore;
  keysStore: ApiKeysStore;
  agentKey: string;
  allKey: string;
  close: () => Promise<void>;
}

async function boot(opts: { withGateway?: boolean } = {}): Promise<Harness> {
  const withGateway = opts.withGateway ?? true;
  const store = new MemoryStore(":memory:");
  const keysStore = new ApiKeysStore(":memory:");
  const { key: agentKey } = keysStore.createKey(AGENT, { label: "ios" });
  const { key: allKey } = keysStore.createAllKey({ label: "all" });

  const memoryGateway = withGateway
    ? createMemoryGateway({
        getStore: (name: string) => (name === AGENT ? store : undefined),
        embed: async () => new Float32Array(384),
      })
    : undefined;

  const handle = await startOpenAiServer({
    port: 0,
    host: "127.0.0.1",
    maxRequestBodyBytes: 1 * 1024 * 1024,
    streamKeepaliveMs: 15_000,
    apiKeysStore: keysStore,
    driver: noopDriver,
    agentNames: () => [AGENT],
    ...(memoryGateway ? { memoryGateway } : {}),
  });

  return {
    baseUrl: `http://127.0.0.1:${handle.address.port}`,
    store,
    keysStore,
    agentKey,
    allKey,
    close: async () => {
      await handle.close();
      keysStore.close();
      store.close();
    },
  };
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

const sample = {
  v: 1,
  id: "5F2A-UUID",
  savedAt: "2026-06-22T13:00:00Z",
  fact: "Prefers a calm sunrise hike over a busy trail.",
  context: "From a conversation about morning plans",
  sourceSessionID: "9C71-UUID",
};

describe("/v1/memory* — clawdy-v2 #8", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await boot();
  });
  afterEach(async () => {
    await h.close();
  });

  it("ingest → list round-trips all StoredMemory fields, id stripped of the ios: prefix", async () => {
    const ing = await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify(sample),
    });
    expect(ing.status).toBe(200);

    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      v: number;
      memories: Array<Record<string, unknown>>;
    };
    expect(body.v).toBe(1);
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]).toMatchObject({
      id: "5F2A-UUID",
      savedAt: "2026-06-22T13:00:00Z",
      fact: "Prefers a calm sunrise hike over a busy trail.",
      context: "From a conversation about morning plans",
      sourceSessionID: "9C71-UUID",
    });
  });

  it("GET is scoped to ios:% — never returns the agent's other memories", async () => {
    // A non-ios memory written straight to the store (e.g. a soul/conversation row).
    h.store.insert(
      { content: "internal soul fact", source: "system", tags: ["soul"], skipDedup: true },
      new Float32Array(384),
    );
    await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify(sample),
    });
    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
    const body = (await res.json()) as { memories: Array<{ fact: string }> };
    expect(body.memories).toHaveLength(1);
    expect(body.memories[0]!.fact).toBe(sample.fact);
  });

  it("ingest is idempotent on id (re-ingest does not duplicate)", async () => {
    for (let i = 0; i < 2; i++) {
      await fetch(`${h.baseUrl}/v1/memory/ingest`, {
        method: "POST",
        headers: auth(h.agentKey),
        body: JSON.stringify(sample),
      });
    }
    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
    const body = (await res.json()) as { memories: unknown[] };
    expect(body.memories).toHaveLength(1);
  });

  it("PATCH edits the fact; list reflects the new text", async () => {
    await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify(sample),
    });
    const patch = await fetch(`${h.baseUrl}/v1/memory/${sample.id}`, {
      method: "PATCH",
      headers: auth(h.agentKey),
      body: JSON.stringify({ fact: "Prefers sunrise hikes." }),
    });
    expect(patch.status).toBe(200);
    expect((await patch.json()) as { matched: boolean }).toMatchObject({ matched: true });

    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
    const body = (await res.json()) as { memories: Array<{ fact: string }> };
    expect(body.memories[0]!.fact).toBe("Prefers sunrise hikes.");
  });

  it("DELETE forgets the entry; list no longer returns it", async () => {
    await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify(sample),
    });
    const del = await fetch(`${h.baseUrl}/v1/memory/${sample.id}`, {
      method: "DELETE",
      headers: auth(h.agentKey),
    });
    expect(del.status).toBe(200);
    expect((await del.json()) as { matched: boolean }).toMatchObject({ matched: true });

    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
    const body = (await res.json()) as { memories: unknown[] };
    expect(body.memories).toHaveLength(0);
  });

  it("rejects a missing/invalid bearer with 401", async () => {
    const noKey = await fetch(`${h.baseUrl}/v1/memory`);
    expect(noKey.status).toBe(401);
    const badKey = await fetch(`${h.baseUrl}/v1/memory`, {
      headers: { Authorization: "Bearer ck_nope" },
    });
    expect(badKey.status).toBe(401);
  });

  it("rejects a scope=all key with 403 (memory requires an agent-scoped key)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.allKey) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("memory_requires_agent_key");
  });

  it("rejects an ingest body missing fact (400)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify({ v: 1, id: "x", savedAt: "2026-06-22T13:00:00Z" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an ingest body with an unrecognized version (400)", async () => {
    const res = await fetch(`${h.baseUrl}/v1/memory/ingest`, {
      method: "POST",
      headers: auth(h.agentKey),
      body: JSON.stringify({ ...sample, v: 2 }),
    });
    expect(res.status).toBe(400);
  });
});

describe("/v1/memory* — feature flag", () => {
  it("returns 501 when no memoryGateway is wired", async () => {
    const h = await boot({ withGateway: false });
    try {
      const res = await fetch(`${h.baseUrl}/v1/memory`, { headers: auth(h.agentKey) });
      expect(res.status).toBe(501);
    } finally {
      await h.close();
    }
  });
});
