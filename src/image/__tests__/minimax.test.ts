import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { createMiniMaxImageClient } from "../providers/minimax.js";
import { imageConfigSchema, type ImageConfig } from "../../config/schema.js";

function makeConfig(overrides: Partial<ImageConfig> = {}): ImageConfig {
  return { ...imageConfigSchema.parse({}), ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createMiniMaxImageClient", () => {
  it("M1: factory does NOT read env at construction", () => {
    const env: NodeJS.ProcessEnv = {};
    const proxy = new Proxy(env, {
      get(_t, prop) {
        throw new Error(`env.${String(prop)} read at construction`);
      },
    });
    expect(() => createMiniMaxImageClient(makeConfig(), proxy)).not.toThrow();
  });

  it("M2: 200 with image_urls → fetches each URL → returns image bytes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // First call: image_generation endpoint
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { image_urls: ["https://cdn.minimax/img1.png"] } }),
          { status: 200 },
        ),
      )
      // Second call: GET image bytes
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }),
      );
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat", n: 1 });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(1);
      expect(outcome.data.images[0].bytes).toBeInstanceOf(Buffer);
      expect(outcome.data.images[0].bytes.length).toBe(4);
      expect(outcome.data.images[0].url).toBe("https://cdn.minimax/img1.png");
      // MiniMax flat rate = 1 cent.
      expect(outcome.data.cost_cents).toBe(1);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // Second fetch must include Authorization header.
    const fetchInit = fetchSpy.mock.calls[1][1] as RequestInit;
    const headers = fetchInit.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mm-test");
  });

  it("M3: edit always returns unsupported_operation naming openai+fal", async () => {
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.edit({ imageBytes: Buffer.from("x"), prompt: "p" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("minimax");
      expect(outcome.error.message).toMatch(/MiniMax does not support image_edit/i);
      expect(outcome.error.message).toMatch(/openai/i);
      expect(outcome.error.message).toMatch(/fal/i);
    }
  });

  it("M4: variations always returns unsupported_operation naming openai", async () => {
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.variations({ imageBytes: Buffer.from("x") });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("minimax");
      expect(outcome.error.message).toMatch(/MiniMax does not support image_variations/i);
      expect(outcome.error.message).toMatch(/openai/i);
    }
  });

  it("M5: missing MINIMAX_API_KEY → invalid_input, no fetch", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createMiniMaxImageClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/missing minimax api key/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("M6: fetch rejects with TypeError → network error, never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed: ENOTFOUND"),
    );
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("network");
      expect(outcome.error.backend).toBe("minimax");
    }
  });

  it("M7: 429 → rate_limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("rate_limit");
      expect(outcome.error.backend).toBe("minimax");
    }
  });

  it("M8: 200 envelope with base_resp.status_code != 0 → invalid_input", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          base_resp: { status_code: 1004, status_msg: "auth failed" },
        }),
        { status: 200 },
      ),
    );
    const client = createMiniMaxImageClient(makeConfig(), {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/1004/);
    }
  });

  it("size_limit when image bytes exceed maxImageBytes", async () => {
    // Create a config with a tiny cap, so any returned image exceeds it.
    const tinyCapConfig = makeConfig({ maxImageBytes: 1 });
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { image_urls: ["https://cdn.minimax/big.png"] } }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
    const client = createMiniMaxImageClient(tinyCapConfig, {
      MINIMAX_API_KEY: "mm-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("size_limit");
  });
});
