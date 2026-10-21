import { describe, it, expect } from "vitest";
import {
  truncateLargePayloads,
  TIER3_TOOL_USE_THRESHOLD,
  TIER3_TOOL_RESULT_THRESHOLD,
} from "../tier3-payload-truncator.js";
import type { ConversationTurn } from "../../../memory/compaction.js";

function turn(role: "user" | "assistant", content: string): ConversationTurn {
  return Object.freeze({ timestamp: "2026-05-14T08:00:00Z", role, content });
}

describe("tier3-payload-truncator", () => {
  it("truncates tool_use content exceeding the 4KB threshold", () => {
    const big = "A".repeat(TIER3_TOOL_USE_THRESHOLD + 100);
    const input = [turn("assistant", `tool_use: pdf_reader args: ${big}`)];
    const out = truncateLargePayloads(input);
    expect(out[0].content).toMatch(
      /^\[tier3\] tool_use: pdf_reader ran, returned a (binary|json|text) payload of \d+ bytes$/,
    );
    expect(out[0].content).not.toContain("AAAA");
  });

  it("truncates tool_result content exceeding the 8KB threshold", () => {
    const big = "B".repeat(TIER3_TOOL_RESULT_THRESHOLD + 100);
    const input = [turn("assistant", `tool_result: mcp_search ${big}`)];
    const out = truncateLargePayloads(input);
    expect(out[0].content).toMatch(
      /^\[tier3\] tool_result: mcp_search ran, returned a (binary|json|text) payload of \d+ bytes$/,
    );
    expect(out[0].content).not.toContain("BBBB");
  });

  it("leaves small tool_use / tool_result content untouched", () => {
    const input = [
      turn("assistant", "tool_use: read_file args: small"),
      turn("assistant", "tool_result: read_file ok"),
      turn("user", "hello"),
    ];
    const out = truncateLargePayloads(input);
    for (let i = 0; i < input.length; i++) {
      expect(out[i].content).toBe(input[i].content);
    }
  });

  it("emits deterministic stub format with name + kind + byte count", () => {
    // Use spaces to break up the long run so the base64 hint doesn't fire.
    const payload = "x ".repeat(Math.ceil(TIER3_TOOL_USE_THRESHOLD / 2) + 50);
    const t = turn("assistant", `tool_use: foo_bar.baz args: ${payload}`);
    const bytes = Buffer.byteLength(t.content, "utf8");
    const out = truncateLargePayloads([t]);
    expect(out[0].content).toBe(
      `[tier3] tool_use: foo_bar.baz ran, returned a text payload of ${bytes} bytes`,
    );
  });

  it("detects base64 payloads as binary kind", () => {
    // 256 chars of valid base64 → triggers BASE64_HINT_RE
    const b64 =
      "TWFuIGlzIGRpc3Rpbmd1aXNoZWQsIG5vdCBvbmx5IGJ5IGhpcyByZWFzb24sIGJ1dCBieSB0aGlz".repeat(
        80,
      );
    const t = turn("assistant", `tool_use: pdf args: ${b64}`);
    const out = truncateLargePayloads([t]);
    expect(out[0].content).toMatch(/binary payload of \d+ bytes$/);
  });

  it("is pure — does not mutate input array or its turns", () => {
    const big = "Z".repeat(TIER3_TOOL_USE_THRESHOLD + 10);
    const t1 = turn("assistant", `tool_use: x args: ${big}`);
    const t2 = turn("user", "hi");
    const input: readonly ConversationTurn[] = Object.freeze([t1, t2]);
    truncateLargePayloads(input);
    expect(t1.content.length).toBeGreaterThan(TIER3_TOOL_USE_THRESHOLD);
    expect(t2.content).toBe("hi");
    expect(input.length).toBe(2);
  });

  it("returns the same array reference when input is empty", () => {
    const out = truncateLargePayloads([]);
    expect(out.length).toBe(0);
  });
});
