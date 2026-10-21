import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingService } from "../embedder.js";

// Mock the @huggingface/transformers module to avoid 23MB model download
vi.mock("@huggingface/transformers", () => {
  const mockPipeline = vi.fn(async () => {
    // Return a function that mimics FeatureExtractionPipeline
    return async (_text: string, _options?: Record<string, unknown>) => ({
      tolist: () => {
        // Return a 384-dim vector
        const vec = Array.from({ length: 384 }, (_, i) => i / 384);
        return [vec];
      },
    });
  });

  return { pipeline: mockPipeline };
});

describe("EmbeddingService", () => {
  let service: EmbeddingService;

  beforeEach(() => {
    service = new EmbeddingService();
    vi.clearAllMocks();
  });

  it("isReady returns false before warmup", () => {
    expect(service.isReady()).toBe(false);
  });

  it("warmup creates pipeline and sets isReady to true", async () => {
    await service.warmup();
    expect(service.isReady()).toBe(true);
  });

  it("warmup is idempotent (only creates pipeline once)", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    await service.warmup();
    await service.warmup();
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("embed returns Float32Array of length 384", async () => {
    const result = await service.embed("test text");
    expect(result).toBeInstanceOf(Float32Array);
    expect(result.length).toBe(384);
  });

  it("embed calls warmup if not ready", async () => {
    expect(service.isReady()).toBe(false);
    await service.embed("text");
    expect(service.isReady()).toBe(true);
  });

  it("long text is truncated before embedding", async () => {
    const { pipeline } = await import("@huggingface/transformers");
    const mockExtractor = vi.fn(
      async (_text: string, _opts?: Record<string, unknown>) => ({
        tolist: () => [Array.from({ length: 384 }, () => 0.1)],
      }),
    );

    vi.mocked(pipeline).mockResolvedValueOnce(
      mockExtractor as unknown as Awaited<ReturnType<typeof pipeline>>,
    );

    // Create a fresh service to use the new mock
    const svc = new EmbeddingService();

    // Generate text with 300 words (exceeds 200 word limit)
    const longText = Array.from({ length: 300 }, (_, i) => `word${i}`).join(
      " ",
    );
    await svc.embed(longText);

    // The extractor should have received truncated text (200 words)
    const calledWith = mockExtractor.mock.calls[0][0] as string;
    const wordCount = calledWith.split(/\s+/).length;
    expect(wordCount).toBe(200);
  });
});
