/**
 * Unit tests for summarizeWithHaiku.
 *
 * Mocks haiku-direct.js so tests never hit the network.
 * summarizeWithHaiku now delegates entirely to callHaikuDirect — the tests
 * verify that delegation is wired correctly.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCallHaikuDirect = vi.fn();

vi.mock("../haiku-direct.js", () => ({
  callHaikuDirect: mockCallHaikuDirect,
}));

const { summarizeWithHaiku, _resetSdkCacheForTests } = await import("../summarize-with-haiku.js");

describe("summarizeWithHaiku", () => {
  beforeEach(() => {
    mockCallHaikuDirect.mockReset();
  });

  it("returns the string from callHaikuDirect", async () => {
    mockCallHaikuDirect.mockResolvedValue("## User Preferences\n- terse\n");
    const result = await summarizeWithHaiku("prompt text", {});
    expect(result).toBe("## User Preferences\n- terse\n");
  });

  it("calls callHaikuDirect with a summarizer system prompt and the user prompt", async () => {
    mockCallHaikuDirect.mockResolvedValue("ok");
    await summarizeWithHaiku("my summarization prompt", {});

    expect(mockCallHaikuDirect).toHaveBeenCalledTimes(1);
    const [system, prompt] = mockCallHaikuDirect.mock.calls[0]! as [string, string, unknown];
    expect(typeof system).toBe("string");
    expect(system).toContain("summarizer");
    expect(prompt).toBe("my summarization prompt");
  });

  it("forwards the caller abort signal to callHaikuDirect", async () => {
    mockCallHaikuDirect.mockResolvedValue("done");
    const controller = new AbortController();
    await summarizeWithHaiku("p", { signal: controller.signal });
    const [, , opts] = mockCallHaikuDirect.mock.calls[0]! as [string, string, { signal?: AbortSignal }];
    expect(opts.signal).toBe(controller.signal);
  });

  it("returns empty string when callHaikuDirect returns empty string", async () => {
    mockCallHaikuDirect.mockResolvedValue("");
    const result = await summarizeWithHaiku("p", {});
    expect(result).toBe("");
  });

  it("_resetSdkCacheForTests is a no-op that does not throw", () => {
    expect(() => _resetSdkCacheForTests()).not.toThrow();
  });
});
