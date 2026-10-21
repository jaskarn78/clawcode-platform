import { describe, it, expect } from "vitest";
import {
  classifyAttachment,
  isEligibleForIngest,
  type ClassifierInput,
} from "../auto-ingest-classifier.js";

/**
 * Phase 999.43 Plan 01 Task 1 — fixture-driven tests for the heuristic
 * classifier. Each test corresponds to a row in the D-01 Axis 2 cascade
 * table (CONTEXT.md `<decisions>`) PLUS the D-06 eligibility filter.
 *
 * Synthetic-only — no real Client C data (Phase 101 truth-fixture pattern).
 */
describe("auto-ingest classifier (Phase 999.43 D-01 Axis 2)", () => {
  it("Test 1: PDF >= 100KB → HIGH", () => {
    const input: ClassifierInput = {
      filename: "client-c-test-tax-return.pdf",
      mimeType: "application/pdf",
      size: 247_000,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("high");
    expect(out.reason).toBe("PDF size 247000 >= 100000");
  });

  it("Test 2: PDF < 100KB → LOW", () => {
    const input: ClassifierInput = {
      filename: "stripe-receipt.pdf",
      mimeType: "application/pdf",
      size: 12_000,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("low");
    expect(out.reason).toBe("PDF size 12000 < 100000");
  });

  it("Test 3: .xlsx → HIGH", () => {
    const input: ClassifierInput = {
      filename: "client-statement.xlsx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      size: 80_000,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("high");
  });

  it("Test 4: Screenshot+form image → LOW", () => {
    const input: ClassifierInput = {
      filename: "Screenshot 2026-05-16 form fill.png",
      mimeType: "image/png",
      size: 200_000,
      visionAnalysis: undefined,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("low");
    expect(out.reason).toMatch(/screenshot.*form/i);
  });

  it("Test 5: random image (no vision) → MEDIUM default", () => {
    const input: ClassifierInput = {
      filename: "random-meme.png",
      mimeType: "image/png",
      size: 50_000,
      visionAnalysis: undefined,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("medium");
    expect(out.reason).toMatch(/default/i);
  });

  it("Test 6: D-06 reject .mp4 → eligible:false", () => {
    const input: ClassifierInput = {
      filename: "vid.mp4",
      mimeType: "video/mp4",
      size: 5_000_000,
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(false);
    expect(out.contentClass).toBe("low");
    expect(out.reason).toMatch(/video/i);
  });

  it("Test 7: image + vision text-heavy → HIGH", () => {
    const input: ClassifierInput = {
      filename: "img.png",
      mimeType: "image/png",
      size: 300_000,
      visionAnalysis:
        "This image shows a brokerage statement with account numbers and balances totaling $123,456",
    };
    const out = classifyAttachment(input);
    expect(out.eligible).toBe(true);
    expect(out.contentClass).toBe("high");
  });

  // --- Cross-cutting invariants on the cascade ----------------------------

  it("D-06 reject: .zip archive → eligible:false", () => {
    const out = classifyAttachment({
      filename: "stuff.zip",
      mimeType: "application/zip",
      size: 100_000,
    });
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/archive/i);
  });

  it("D-06 reject: .mp3 audio → eligible:false", () => {
    const out = classifyAttachment({
      filename: "song.mp3",
      mimeType: "audio/mpeg",
      size: 4_000_000,
    });
    expect(out.eligible).toBe(false);
    expect(out.reason).toMatch(/audio/i);
  });

  it("isEligibleForIngest stand-alone matches the cascade filter", () => {
    expect(isEligibleForIngest({ filename: "a.mp4", mimeType: null, size: 1 }).eligible).toBe(false);
    expect(isEligibleForIngest({ filename: "a.pdf", mimeType: null, size: 1 }).eligible).toBe(true);
  });

  it("Code file (.ts) → LOW", () => {
    const out = classifyAttachment({
      filename: "main.ts",
      mimeType: "text/plain",
      size: 5_000,
    });
    expect(out.contentClass).toBe("low");
    expect(out.reason).toMatch(/code/i);
  });

  it("Plaintext (.md) → MEDIUM", () => {
    const out = classifyAttachment({
      filename: "notes.md",
      mimeType: "text/markdown",
      size: 2_000,
    });
    expect(out.contentClass).toBe("medium");
  });

  it("Image + client-name match → HIGH (Axis 2 client-name rung)", () => {
    const out = classifyAttachment({
      filename: "Client_A-2026-portfolio.png",
      mimeType: "image/png",
      size: 100_000,
      clientNamePatterns: ["client_a", "client_c"],
    });
    expect(out.contentClass).toBe("high");
    expect(out.reason).toMatch(/client-name/i);
  });

  it("Image + vision web/UI → LOW", () => {
    const out = classifyAttachment({
      filename: "snap.png",
      mimeType: "image/png",
      size: 80_000,
      visionAnalysis: "A login form on a webpage with a submit button",
    });
    expect(out.contentClass).toBe("low");
  });

  it("Screenshot without form-keyword → MEDIUM", () => {
    const out = classifyAttachment({
      filename: "Screenshot 2026-05-16 dashboard.png",
      mimeType: "image/png",
      size: 100_000,
    });
    expect(out.contentClass).toBe("medium");
    expect(out.reason).toMatch(/screenshot/i);
  });

  it("Unknown extension non-image → MEDIUM fallback", () => {
    const out = classifyAttachment({
      filename: "weird.xyz",
      mimeType: "application/octet-stream",
      size: 1_000,
    });
    expect(out.contentClass).toBe("medium");
    expect(out.reason).toMatch(/default fallback/i);
  });
});
