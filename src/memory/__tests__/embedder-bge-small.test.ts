import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  embedBgeSmall,
  warmupBgeSmall,
  isBgeSmallReady,
  BGE_SMALL_DIM,
  BGE_SMALL_MODEL_ID,
  _resetBgeSmallForTests,
} from "../embedder-bge-small.js";

/**
 * Phase 115 D-06 — bge-small-en-v1.5 ONNX embedder tests.
 *
 * Uses mocked @huggingface/transformers per the existing
 * `src/memory/__tests__/embedder.test.ts` pattern to avoid downloading
 * a ~33MB model in CI. The mock returns deterministic 384-dim output
 * via `.tolist()` (the v3 path) plus a separate test that exercises
 * the `.data` (v4 fast path) branch to ensure both shapes are handled
 * by `embedBgeSmall`'s output adapter.
 */

vi.mock("@huggingface/transformers", () => {
  const mockPipeline = vi.fn(async () => {
    return async (_text: string, _options?: Record<string, unknown>) => ({
      tolist: () => {
        const vec = Array.from({ length: 384 }, (_, i) => i / 384);
        return [vec];
      },
    });
  });
  return { pipeline: mockPipeline };
});

describe("embedder-bge-small (Phase 115 D-06)", () => {
  beforeEach(() => {
    _resetBgeSmallForTests();
    vi.clearAllMocks();
  });

  it("BGE_SMALL_MODEL_ID is the locked D-06 model id", () => {
    // Static-grep regression pin — bge-small-en-v1.5 is the locked default.
    expect(BGE_SMALL_MODEL_ID).toBe("BAAI/bge-small-en-v1.5");
  });

  it("BGE_SMALL_DIM is 384 (matches MiniLM, no MRL truncation)", () => {
    expect(BGE_SMALL_DIM).toBe(384);
  });

  it("isBgeSmallReady returns false before warmup", () => {
    expect(isBgeSmallReady()).toBe(false);
  });

  it("warmupBgeSmall is idempotent (only constructs pipeline once)", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    await warmupBgeSmall();
    await warmupBgeSmall();
    await warmupBgeSmall();
    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(isBgeSmallReady()).toBe(true);
  });

  it("warmupBgeSmall passes the locked model id + fp32 dtype", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    await warmupBgeSmall();
    expect(pipeline).toHaveBeenCalledWith(
      "feature-extraction",
      "BAAI/bge-small-en-v1.5",
      { dtype: "fp32" },
    );
  });

  it("embedBgeSmall returns Float32Array of length 384", async () => {
    const result = await embedBgeSmall("hello world");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  it("embedBgeSmall passes pooling=mean + normalize=true to the pipeline (D-06 retrieval setup)", async () => {
    const { pipeline } = await import("@huggingface/transformers");

    let capturedOptions: Record<string, unknown> | undefined;
    const mockExtractor = vi.fn(
      async (_text: string, opts?: Record<string, unknown>) => {
        capturedOptions = opts;
        return { tolist: () => [Array.from({ length: 384 }, () => 0.1)] };
      },
    );
    vi.mocked(pipeline).mockResolvedValueOnce(
      mockExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
    );

    _resetBgeSmallForTests();
    await embedBgeSmall("test");

    expect(capturedOptions).toEqual({ pooling: "mean", normalize: true });
  });

  it("embedBgeSmall handles the `.data` (v4 fast path) output shape", async () => {
    const { pipeline } = await import("@huggingface/transformers");

    const mockExtractor = vi.fn(
      async (_text: string, _opts?: Record<string, unknown>) => ({
        // v4 fast-path output — has .data, NO .tolist
        data: new Float32Array(Array.from({ length: 384 }, () => 0.5)),
      }),
    );
    vi.mocked(pipeline).mockResolvedValueOnce(
      mockExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
    );

    _resetBgeSmallForTests();
    const result = await embedBgeSmall("test");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
    expect(result[0]).toBe(0.5);
  });

  it("embedBgeSmall truncates 200+ word input to 200 words (matches MiniLM truncation discipline)", async () => {
    const { pipeline } = await import("@huggingface/transformers");

    let capturedText: string | undefined;
    const mockExtractor = vi.fn(
      async (text: string, _opts?: Record<string, unknown>) => {
        capturedText = text;
        return { tolist: () => [Array.from({ length: 384 }, () => 0.1)] };
      },
    );
    vi.mocked(pipeline).mockResolvedValueOnce(
      mockExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
    );

    _resetBgeSmallForTests();
    const longText = Array.from({ length: 500 }, (_, i) => `word${i}`).join(
      " ",
    );
    await embedBgeSmall(longText);

    expect(capturedText).toBeDefined();
    const wordCount = capturedText!.split(/\s+/).length;
    expect(wordCount).toBe(200);
  });

  it("embedBgeSmall throws EmbeddingError when pipeline returns wrong dim", async () => {
    const { pipeline } = await import("@huggingface/transformers");

    const mockExtractor = vi.fn(
      async (_text: string, _opts?: Record<string, unknown>) => ({
        // Wrong dim — should error.
        tolist: () => [Array.from({ length: 256 }, () => 0.1)],
      }),
    );
    vi.mocked(pipeline).mockResolvedValueOnce(
      mockExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
    );

    _resetBgeSmallForTests();
    await expect(embedBgeSmall("test")).rejects.toThrow(/256-dim/);
  });

  it("embedBgeSmall auto-warms on first call", async () => {
    expect(isBgeSmallReady()).toBe(false);
    await embedBgeSmall("first call");
    expect(isBgeSmallReady()).toBe(true);
  });
});
