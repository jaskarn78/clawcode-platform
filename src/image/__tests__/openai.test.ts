import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { createOpenAiImageClient } from "../providers/openai.js";
import { imageConfigSchema, type ImageConfig } from "../../config/schema.js";

function makeConfig(overrides: Partial<ImageConfig> = {}): ImageConfig {
  return { ...imageConfigSchema.parse({}), ...overrides };
}

/** A 1x1 transparent PNG, base64-encoded. Big enough to round-trip through Buffer.from. */
const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createOpenAiImageClient", () => {
  it("O1: factory does NOT read env at construction", () => {
    const env: NodeJS.ProcessEnv = {};
    const proxy = new Proxy(env, {
      get(_target, prop) {
        // If construction reads any env property, fail loudly.
        throw new Error(`env.${String(prop)} read at construction`);
      },
    });
    // Construction must not touch env keys; passing a Proxy that throws on get
    // is the strongest possible guard.
    expect(() => createOpenAiImageClient(makeConfig(), proxy)).not.toThrow();
  });

  it("O2: missing OPENAI_API_KEY → invalid_input with helpful message, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createOpenAiImageClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/missing openai api key/i);
      expect(outcome.error.backend).toBe("openai");
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("O3: 200 with 2 b64_json images → success with decoded Buffers + cost from rate card", async () => {
    const body = {
      data: [{ b64_json: TINY_PNG_B64 }, { b64_json: TINY_PNG_B64 }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat", n: 2 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(2);
      expect(outcome.data.images[0].bytes).toBeInstanceOf(Buffer);
      expect(outcome.data.images[0].bytes.length).toBeGreaterThan(0);
      expect(outcome.data.images[0].size).toBe("1024x1024");
      expect(outcome.data.images[0].model).toBe("gpt-image-1");
      // Default rate card: gpt-image-1 1024x1024 = 4 cents/image × 2.
      expect(outcome.data.cost_cents).toBe(8);
    }
  });

  it("O4: 429 → rate_limit error with status=429", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "30" },
      }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("rate_limit");
      expect(outcome.error.status).toBe(429);
      expect(outcome.error.backend).toBe("openai");
    }
  });

  it("O5: 400 with content_policy_violation body → content_policy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "content_policy_violation",
            message: "Your request was rejected as a result of our safety system.",
          },
        }),
        { status: 400 },
      ),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "bad prompt" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("content_policy");
      expect(outcome.error.backend).toBe("openai");
      expect(outcome.error.status).toBe(400);
    }
  });

  it("O6: edit happy path with maskBytes — multipart sent + 200 → success", async () => {
    const body = { data: [{ b64_json: TINY_PNG_B64 }] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.edit({
      imageBytes: Buffer.from("fake-image-bytes"),
      prompt: "make it blue",
      maskBytes: Buffer.from("fake-mask"),
    });
    expect(outcome.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    // FormData body — content-type set automatically by fetch.
    expect(init.body).toBeInstanceOf(FormData);
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-test");
  });

  it("O7: variations happy path — multipart sent + 200 → success", async () => {
    const body = { data: [{ b64_json: TINY_PNG_B64 }, { b64_json: TINY_PNG_B64 }] };
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.variations({
      imageBytes: Buffer.from("fake"),
      n: 2,
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.data.images).toHaveLength(2);
  });

  it("O8: fetch rejects with TypeError → network error, never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed: ECONNREFUSED"),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("network");
      expect(outcome.error.backend).toBe("openai");
    }
  });

  it("emits Authorization: Bearer + JSON content-type on outbound generate", async () => {
    const body = { data: [{ b64_json: TINY_PNG_B64 }] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-secret",
    } as NodeJS.ProcessEnv);
    await client.generate({ prompt: "x" });
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-secret");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("lazy API-key read: key absent at construction, present at generate time", async () => {
    const env: NodeJS.ProcessEnv = {};
    const client = createOpenAiImageClient(makeConfig(), env);
    env.OPENAI_API_KEY = "sk-late";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), { status: 200 }),
    );
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(true);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer sk-late");
  });

  it("500 → backend_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal Server Error", { status: 500 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("backend_unavailable");
      expect(outcome.error.status).toBe(500);
    }
  });

  it("response without b64_json → internal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ url: "https://x" }] }), { status: 200 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("internal");
  });

  it("empty data array → internal", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const client = createOpenAiImageClient(makeConfig(), {
      OPENAI_API_KEY: "sk-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("internal");
  });
});
