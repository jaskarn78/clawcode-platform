import { describe, it, expect, vi } from "vitest";
import { handleVerboseSlash } from "../slash-commands.js";

/**
 * Phase 117 Plan 117-11 T07 — pure-handler tests for the /clawcode-verbose
 * slash dispatch logic. Mirrors the test pattern used by handleInterruptSlash
 * + handleSteerSlash (src/discord/__tests__/slash-interrupt-steer.test.ts)
 * — exercise the pure exported handler against a mocked sendIpc so the
 * SlashCommandHandler class doesn't need instantiation.
 *
 * Five assertions per the plan T07 spec:
 *   A: level="on"  → IPC called with the on payload; reply contains "verbose"
 *   B: level="off" → IPC called with the off payload; reply contains "normal"
 *   C: level="status" → reply contains the level + updatedAt timestamp
 *   D: IPC returned {error} → reply renders the error string
 *   E: ephemeral-ness invariant — `handleVerboseSlash` returns only a string
 *      (the caller in handleControlCommand wraps it in editReply, which is
 *      already ephemeral from the deferReply({ephemeral:true}) at :4017).
 *      We assert the handler does NOT instruct any non-ephemeral channel
 *      write — the string-only return shape is the structural guarantee.
 */

describe("handleVerboseSlash", () => {
  // A — level=on dispatches set-verbose-level with level=on; reply renders the resolved level.
  it("A: level=on → IPC called with on payload; reply confirms verbose", async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      level: "verbose",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const reply = await handleVerboseSlash({
      channelId: "chan-1",
      level: "on",
      sendIpc,
    });
    expect(sendIpc).toHaveBeenCalledTimes(1);
    expect(sendIpc).toHaveBeenCalledWith("set-verbose-level", {
      channelId: "chan-1",
      level: "on",
    });
    expect(reply).toBe("verbose: verbose for this channel");
  });

  // B — level=off dispatches with level=off; reply confirms normal.
  it("B: level=off → IPC called with off payload; reply confirms normal", async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      level: "normal",
      updatedAt: "2026-05-13T00:01:00.000Z",
    });
    const reply = await handleVerboseSlash({
      channelId: "chan-2",
      level: "off",
      sendIpc,
    });
    expect(sendIpc).toHaveBeenCalledWith("set-verbose-level", {
      channelId: "chan-2",
      level: "off",
    });
    expect(reply).toBe("verbose: normal for this channel");
  });

  // C — level=status renders the IPC-returned timestamp.
  it("C: level=status → reply includes current level + updatedAt", async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      level: "verbose",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const reply = await handleVerboseSlash({
      channelId: "chan-3",
      level: "status",
      sendIpc,
    });
    expect(sendIpc).toHaveBeenCalledWith("set-verbose-level", {
      channelId: "chan-3",
      level: "status",
    });
    expect(reply).toBe(
      "verbose: verbose (last changed 2026-05-13T00:00:00.000Z)",
    );
  });

  // D — IPC returns {error: ...} → reply surfaces the error string verbatim.
  it("D: IPC returns {error} → reply renders 'verbose: <error>'", async () => {
    const sendIpc = vi
      .fn()
      .mockResolvedValue({ error: "channel id not bound" });
    const reply = await handleVerboseSlash({
      channelId: "chan-4",
      level: "on",
      sendIpc,
    });
    expect(reply).toBe("verbose: channel id not bound");
  });

  // E — ephemeral-ness invariant — return shape is a string, no side-effect
  //     channels touched. The caller wraps in interaction.editReply (already
  //     ephemeral via deferReply({ephemeral:true})). This test guards against
  //     a future refactor accidentally returning a non-string or invoking
  //     interaction.reply directly inside the pure handler.
  it("E: handler returns only a string (no side-effect writes) — ephemeral inheritance guarantee", async () => {
    const sendIpc = vi.fn().mockResolvedValue({
      level: "verbose",
      updatedAt: "2026-05-13T00:00:00.000Z",
    });
    const reply = await handleVerboseSlash({
      channelId: "chan-5",
      level: "on",
      sendIpc,
    });
    expect(typeof reply).toBe("string");
    // No second IPC method, no broadcast side effects.
    expect(sendIpc).toHaveBeenCalledTimes(1);
  });
});
