import { describe, it, expect, vi, afterEach } from "vitest";
import { Buffer } from "node:buffer";
import {
  imageEdit,
  imageGenerate,
  imageVariations,
  TOOL_DEFINITIONS,
  type ImageProvider,
  type ImageToolDeps,
} from "../tools.js";
import { imageConfigSchema, type ImageConfig } from "../../config/schema.js";
import type { ProviderImageBatch } from "../providers/openai.js";
import type { ImageBackend, ImageToolOutcome } from "../types.js";

function makeConfig(overrides: Partial<ImageConfig> = {}): ImageConfig {
  return { ...imageConfigSchema.parse({}), ...overrides };
}

function makeBatch(
  count: number,
  costCents: number,
  size = "1024x1024",
  model = "gpt-image-1",
): ImageToolOutcome<ProviderImageBatch> {
  const images = Array.from({ length: count }, (_, i) =>
    Object.freeze({
      bytes: Buffer.from(`fake-image-${i}`),
      size,
      model,
    }),
  );
  return Object.freeze({
    ok: true as const,
    data: Object.freeze({
      images: Object.freeze(images),
      cost_cents: costCents,
    }),
  });
}

function makeProvider(overrides: Partial<ImageProvider> = {}): ImageProvider {
  return {
    generate: vi.fn().mockResolvedValue(makeBatch(1, 4)),
    edit: vi.fn().mockResolvedValue(makeBatch(1, 4)),
    variations: vi.fn().mockResolvedValue(makeBatch(1, 4)),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ImageToolDeps> = {}): ImageToolDeps {
  let counter = 0;
  return {
    config: makeConfig(),
    providers: {
      openai: makeProvider(),
      minimax: makeProvider({
        edit: vi.fn().mockResolvedValue({
          ok: false,
          error: Object.freeze({
            type: "unsupported_operation" as const,
            message:
              "MiniMax does not support image_edit. Backends with edit support: openai, fal.",
            backend: "minimax" as ImageBackend,
          }),
        }),
        variations: vi.fn().mockResolvedValue({
          ok: false,
          error: Object.freeze({
            type: "unsupported_operation" as const,
            message:
              "MiniMax does not support image_variations. Backends with variations support: openai.",
            backend: "minimax" as ImageBackend,
          }),
        }),
      }),
      fal: makeProvider({
        variations: vi.fn().mockResolvedValue({
          ok: false,
          error: Object.freeze({
            type: "unsupported_operation" as const,
            message: "fal.ai does not support image_variations.",
            backend: "fal" as ImageBackend,
          }),
        }),
      }),
    },
    writeImage: vi
      .fn()
      .mockImplementation(async (ws: string, sub: string, _b: Buffer, ext: string) => {
        counter += 1;
        return `${ws}/${sub}/img-${counter}.${ext}`;
      }),
    recordCost: vi.fn(),
    agentWorkspace: "/tmp/test-ws",
    agent: "clawdy",
    sessionId: "sess-1",
    readFile: vi.fn().mockResolvedValue(Buffer.from("source-bytes")),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// imageGenerate
// ---------------------------------------------------------------------------

describe("imageGenerate", () => {
  it("G1: empty prompt → invalid_input, no provider call", async () => {
    const deps = makeDeps();
    const outcome = await imageGenerate({ prompt: "" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
    expect(deps.providers.openai.generate).not.toHaveBeenCalled();
  });

  it("G2: invalid n (0, 5, -1) → invalid_input", async () => {
    const deps = makeDeps();
    for (const n of [0, 5, -1]) {
      const outcome = await imageGenerate({ prompt: "cat", n }, deps);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
    }
  });

  it("G3: backend resolution arg > config; unknown backend → invalid_input", async () => {
    const deps = makeDeps();
    // Default config.backend = openai; arg='fal' must dispatch to fal client.
    await imageGenerate({ prompt: "cat", backend: "fal" }, deps);
    expect(deps.providers.fal.generate).toHaveBeenCalled();
    expect(deps.providers.openai.generate).not.toHaveBeenCalled();

    // Unknown backend.
    const outcome = await imageGenerate({ prompt: "cat", backend: "stable-diffusion" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
  });

  it("G4: happy path — provider returns 1 image → writeImage called → success with path+cost", async () => {
    const deps = makeDeps();
    const outcome = await imageGenerate({ prompt: "cat" }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(1);
      expect(outcome.data.images[0].path).toBe("/tmp/test-ws/generated-images/img-1.png");
      expect(outcome.data.images[0].backend).toBe("openai");
      expect(outcome.data.images[0].model).toBe("gpt-image-1");
      expect(outcome.data.images[0].prompt).toBe("cat");
      expect(outcome.data.images[0].cost_cents).toBe(4);
      expect(outcome.data.total_cost_cents).toBe(4);
    }
    expect(deps.writeImage).toHaveBeenCalledTimes(1);
  });

  it("G5: provider returns error → propagated verbatim, no double-wrap", async () => {
    const providerErr = Object.freeze({
      type: "rate_limit" as const,
      message: "throttled",
      backend: "openai" as ImageBackend,
      status: 429,
    });
    const deps = makeDeps({
      providers: {
        openai: makeProvider({
          generate: vi.fn().mockResolvedValue({ ok: false, error: providerErr }),
        }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageGenerate({ prompt: "cat" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBe(providerErr); // referential identity — verbatim pass-through
      expect(outcome.error.type).toBe("rate_limit");
    }
    expect(deps.writeImage).not.toHaveBeenCalled();
    expect(deps.recordCost).not.toHaveBeenCalled();
  });

  it("G6: writeImage rejects → internal error", async () => {
    const deps = makeDeps({
      writeImage: vi.fn().mockRejectedValue(new Error("ENOSPC: disk full")),
    });
    const outcome = await imageGenerate({ prompt: "cat" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("internal");
      expect(outcome.error.message).toMatch(/disk full/);
    }
    expect(deps.recordCost).not.toHaveBeenCalled();
  });

  it("G7: cost recording — recordCost called once with category-suitable shape", async () => {
    const deps = makeDeps();
    await imageGenerate({ prompt: "cat" }, deps);
    expect(deps.recordCost).toHaveBeenCalledTimes(1);
    const event = (deps.recordCost as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(event.backend).toBe("openai");
    expect(event.model).toBe("gpt-image-1");
    expect(event.count).toBe(1);
    expect(event.cost_cents).toBe(4);
    expect(event.size).toBe("1024x1024");
    expect(event.agent).toBe("clawdy");
    expect(event.session_id).toBe("sess-1");
  });

  it("G8: n=3 → 3 images written, 3 paths returned, total_cost_cents = sum", async () => {
    const deps = makeDeps({
      providers: {
        openai: makeProvider({ generate: vi.fn().mockResolvedValue(makeBatch(3, 12)) }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageGenerate({ prompt: "cat", n: 3 }, deps);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(3);
      expect(outcome.data.total_cost_cents).toBe(12);
      // Each image got 12/3 = 4 cents.
      outcome.data.images.forEach((img) => expect(img.cost_cents).toBe(4));
    }
    expect(deps.writeImage).toHaveBeenCalledTimes(3);
  });

  it("G9: provider throws (defence in depth) → internal error, never throws", async () => {
    const deps = makeDeps({
      providers: {
        openai: makeProvider({
          generate: vi.fn().mockRejectedValue(new TypeError("synthetic")),
        }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageGenerate({ prompt: "cat" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      // TypeError with /synthetic/ — no /fetch/i match → fallback "internal".
      expect(outcome.error.type).toBe("internal");
    }
  });

  it("G10: model override — args.model='dall-e-2' is forwarded to provider", async () => {
    const deps = makeDeps();
    await imageGenerate({ prompt: "cat", model: "dall-e-2" }, deps);
    const call = (deps.providers.openai.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].model).toBe("dall-e-2");
  });

  it("invalid size → invalid_input", async () => {
    const deps = makeDeps();
    const outcome = await imageGenerate({ prompt: "cat", size: "999x999" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
  });

  it("recordCost throw does NOT fail the tool (cost recording is non-fatal)", async () => {
    const deps = makeDeps({
      recordCost: vi.fn().mockImplementation(() => {
        throw new Error("DB locked");
      }),
    });
    // Suppress console.warn for the test.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const outcome = await imageGenerate({ prompt: "cat" }, deps);
    expect(outcome.ok).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// imageEdit
// ---------------------------------------------------------------------------

describe("imageEdit", () => {
  it("E1: imagePath fails to read → invalid_input with path in message", async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT: no such file")),
    });
    const outcome = await imageEdit(
      { imagePath: "/tmp/missing.png", prompt: "blue" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/missing\.png/);
    }
  });

  it("E2: backend='minimax' → unsupported_operation passed through verbatim", async () => {
    const deps = makeDeps();
    const outcome = await imageEdit(
      { imagePath: "/tmp/x.png", prompt: "blue", backend: "minimax" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("minimax");
      expect(outcome.error.message).toMatch(/openai/);
      expect(outcome.error.message).toMatch(/fal/);
    }
    // writeImage not called.
    expect(deps.writeImage).not.toHaveBeenCalled();
  });

  it("E3: backend='openai' happy path — readFile → provider.edit → writeImage → success", async () => {
    const deps = makeDeps();
    const outcome = await imageEdit(
      { imagePath: "/tmp/source.png", prompt: "blue" },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(1);
      expect(outcome.data.images[0].prompt).toBe("blue");
    }
    expect(deps.readFile).toHaveBeenCalledWith("/tmp/source.png");
    expect(deps.providers.openai.edit).toHaveBeenCalledTimes(1);
    expect(deps.writeImage).toHaveBeenCalledTimes(1);
  });

  it("E4: maskPath provided → readFile called for mask + maskBytes forwarded to provider", async () => {
    const deps = makeDeps();
    await imageEdit(
      { imagePath: "/tmp/src.png", prompt: "blue", maskPath: "/tmp/mask.png" },
      deps,
    );
    expect(deps.readFile).toHaveBeenCalledWith("/tmp/src.png");
    expect(deps.readFile).toHaveBeenCalledWith("/tmp/mask.png");
    const call = (deps.providers.openai.edit as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0].maskBytes).toBeDefined();
  });

  it("E5: maskPath read fails → invalid_input", async () => {
    const readFile = vi.fn().mockImplementation(async (path: string) => {
      if (path === "/tmp/mask.png") throw new Error("ENOENT");
      return Buffer.from("ok");
    });
    const deps = makeDeps({ readFile });
    const outcome = await imageEdit(
      { imagePath: "/tmp/src.png", prompt: "blue", maskPath: "/tmp/mask.png" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/mask\.png/);
    }
  });

  it("E6: provider throws → internal, never throws", async () => {
    const deps = makeDeps({
      providers: {
        openai: makeProvider({
          edit: vi.fn().mockRejectedValue(new Error("boom")),
        }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageEdit({ imagePath: "/tmp/x.png", prompt: "p" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("internal");
  });
});

// ---------------------------------------------------------------------------
// imageVariations
// ---------------------------------------------------------------------------

describe("imageVariations", () => {
  it("V1: backend='minimax' → unsupported_operation, no writeImage", async () => {
    const deps = makeDeps();
    const outcome = await imageVariations(
      { imagePath: "/tmp/x.png", backend: "minimax" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("minimax");
    }
    expect(deps.writeImage).not.toHaveBeenCalled();
  });

  it("V1b: backend='fal' → unsupported_operation", async () => {
    const deps = makeDeps();
    const outcome = await imageVariations(
      { imagePath: "/tmp/x.png", backend: "fal" },
      deps,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("unsupported_operation");
      expect(outcome.error.backend).toBe("fal");
    }
  });

  it("V2: backend='openai' n=2 happy path — 2 images written, 2 paths", async () => {
    const deps = makeDeps({
      providers: {
        openai: makeProvider({ variations: vi.fn().mockResolvedValue(makeBatch(2, 8)) }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageVariations(
      { imagePath: "/tmp/x.png", n: 2 },
      deps,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.data.images).toHaveLength(2);
      expect(outcome.data.total_cost_cents).toBe(8);
    }
    expect(deps.writeImage).toHaveBeenCalledTimes(2);
  });

  it("V3: imagePath read fails → invalid_input", async () => {
    const deps = makeDeps({
      readFile: vi.fn().mockRejectedValue(new Error("ENOENT")),
    });
    const outcome = await imageVariations({ imagePath: "/tmp/missing.png" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.type).toBe("invalid_input");
      expect(outcome.error.message).toMatch(/missing\.png/);
    }
  });

  it("V4: provider throws → internal", async () => {
    const deps = makeDeps({
      providers: {
        openai: makeProvider({
          variations: vi.fn().mockRejectedValue(new Error("boom")),
        }),
        minimax: makeProvider(),
        fal: makeProvider(),
      },
    });
    const outcome = await imageVariations({ imagePath: "/tmp/x.png" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("internal");
  });

  it("missing imagePath → invalid_input", async () => {
    const deps = makeDeps();
    const outcome = await imageVariations({ imagePath: "" }, deps);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.type).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// TOOL_DEFINITIONS
// ---------------------------------------------------------------------------

describe("TOOL_DEFINITIONS", () => {
  it("TD1: exactly 3 entries — image_generate, image_edit, image_variations (frozen)", () => {
    expect(TOOL_DEFINITIONS).toHaveLength(3);
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    expect(names).toContain("image_generate");
    expect(names).toContain("image_edit");
    expect(names).toContain("image_variations");
    expect(Object.isFrozen(TOOL_DEFINITIONS)).toBe(true);
    TOOL_DEFINITIONS.forEach((t) => expect(Object.isFrozen(t)).toBe(true));
  });

  it("TD2: each schemaBuilder returns object with required keys", async () => {
    const { z } = await import("zod/v4");
    const generateDef = TOOL_DEFINITIONS.find((t) => t.name === "image_generate")!;
    const editDef = TOOL_DEFINITIONS.find((t) => t.name === "image_edit")!;
    const varDef = TOOL_DEFINITIONS.find((t) => t.name === "image_variations")!;

    const generateSchema = generateDef.schemaBuilder(z);
    expect(generateSchema).toHaveProperty("prompt");

    const editSchema = editDef.schemaBuilder(z);
    expect(editSchema).toHaveProperty("imagePath");
    expect(editSchema).toHaveProperty("prompt");

    const varSchema = varDef.schemaBuilder(z);
    expect(varSchema).toHaveProperty("imagePath");
  });

  it("TD3: descriptions mention which backends support which operation", () => {
    const generateDef = TOOL_DEFINITIONS.find((t) => t.name === "image_generate")!;
    const editDef = TOOL_DEFINITIONS.find((t) => t.name === "image_edit")!;
    const varDef = TOOL_DEFINITIONS.find((t) => t.name === "image_variations")!;

    expect(generateDef.description.toLowerCase()).toMatch(/openai|gpt-image-1/);
    expect(generateDef.description.toLowerCase()).toMatch(/minimax/);
    expect(generateDef.description.toLowerCase()).toMatch(/fal/);

    expect(editDef.description.toLowerCase()).toMatch(/openai/);
    expect(editDef.description.toLowerCase()).toMatch(/fal/);
    expect(editDef.description.toLowerCase()).toMatch(/minimax does not support/);

    expect(varDef.description.toLowerCase()).toMatch(/openai/);
    expect(varDef.description.toLowerCase()).toMatch(/minimax|fal/);
  });
});
