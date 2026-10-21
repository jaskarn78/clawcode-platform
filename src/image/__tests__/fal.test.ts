import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import { createFalImageClient } from "../providers/fal.js";
import { imageConfigSchema, type ImageConfig } from "../../config/schema.js";

function makeConfig(overrides: Partial<ImageConfig> = {}): ImageConfig {
  return { ...imageConfigSchema.parse({}), ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createFalImageClient", () => {
  it("F1: factory does NOT read env at construction", () => {
    const env: NodeJS.ProcessEnv = {};
    const proxy = new Proxy(env, {
      get(_t, prop) {
        throw new Error(`env.${String(prop)} read at construction`);
      },
    });
    expect(() => createFalImageClient(makeConfig(), proxy)).not.toThrow();
  });

  it("F2: 200 with images[].url → fetches each URL → returns image bytes", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            images: [{ url: "https://fal.cdn/img1.png", content_type: "image/png" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), { status: 200 }),
      );
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(1);
      expect(outcome.data.images[0].bytes).toBeInstanceOf(Buffer);
      expect(outcome.data.images[0].url).toBe("https://fal.cdn/img1.png");
      // flux-pro flat rate = 5 cents.
      expect(outcome.data.cost_cents).toBe(5);
    }
    // Outbound auth header is "Key ..." not "Bearer ...".
    const generateInit = fetchSpy.mock.calls[0][1] as RequestInit;
    const generateHeaders = generateInit.headers as Record<string, string>;
    expect(generateHeaders.Authorization).toBe("Key fal-test");
  });

  it("F3: edit success — flux-image-to-image → returns new image", async () => {
    vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            images: [{ url: "https://fal.cdn/edited.png", content_type: "image/png" }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), { status: 200 }),
      );
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.edit({
      imageBytes: Buffer.from("original"),
      prompt: "make it blue",
    });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(1);
      // Flux edit model rate = 3 cents.
      expect(outcome.data.cost_cents).toBe(3);
    }
  });

  it("F4: variations always returns unsupported_operation naming openai", async () => {
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.variations();
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("fal");
      expect(outcome.error.message).toMatch(/fal\.ai does not support image_variations/i);
      expect(outcome.error.message).toMatch(/openai/i);
    }
  });

  it("F5: missing FAL_API_KEY → invalid_input on generate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const client = createFalImageClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/missing fal.ai api key/i);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("F6: fetch rejects with TypeError → network error, never throws", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("fetch failed: ECONNRESET"),
    );
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("network");
      expect(outcome.error.backend).toBe("fal");
    }
  });

  it("missing FAL_API_KEY on edit → invalid_input", async () => {
    const client = createFalImageClient(makeConfig(), {} as NodeJS.ProcessEnv);
    const outcome = await client.edit({
      imageBytes: Buffer.from("x"),
      prompt: "p",
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
  });

  it("400 with NSFW marker → content_policy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("NSFW content detected", { status: 400 }),
    );
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "bad" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("content_policy");
      expect(outcome.error.backend).toBe("fal");
    }
  });

  it("500 → backend_unavailable", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("error", { status: 502 }),
    );
    const client = createFalImageClient(makeConfig(), {
      FAL_API_KEY: "fal-test",
    } as NodeJS.ProcessEnv);
    const outcome = await client.generate({ prompt: "cat" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("backend_unavailable");
      expect(outcome.error.status).toBe(502);
    }
  });
});
