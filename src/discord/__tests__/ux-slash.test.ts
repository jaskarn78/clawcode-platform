/**
 * Phase 999.171 — `/clawcode-ux`: IPC routing and reply shaping, without a
 * Discord client. Replies are plain text (no emoji) and say when a change
 * takes effect.
 */
import { describe, expect, it, vi } from "vitest";
import { handleUxSlash } from "../ux-slash.js";

type IpcResult = Record<string, unknown>;

const BASE: IpcResult = {
  agent: "personal",
  feature: "liveThinking",
  state: "status",
  enabled: true,
  source: "config",
  configEnabled: true,
  applies: "next-turn",
};

function ipc(result: IpcResult) {
  return vi.fn(async (_method: string, _params: Record<string, unknown>) => ({ ...BASE, ...result }));
}

const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;

describe("/clawcode-ux", () => {
  it("off sends set-ux-feature and confirms the change persists and applies next turn", async () => {
    const send = ipc({ state: "off", enabled: false, source: "override" });
    const reply = await handleUxSlash({ agent: "personal", feature: "thinking", state: "off", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-ux-feature", { agent: "personal", feature: "thinking", state: "off" });
    expect(reply).toBe("Live thinking **off** for **personal** — kept across restarts.\nTakes effect on the next turn.");
  });

  it("on renders the effective state from the daemon response", async () => {
    const send = ipc({ state: "on", enabled: true, source: "override" });
    const reply = await handleUxSlash({ agent: "personal", feature: "thinking", state: "on", sendIpc: send });
    expect(reply).toContain("Live thinking **on** for **personal** — kept across restarts.");
  });

  it("a bare invocation is a status read", async () => {
    const send = ipc({});
    await handleUxSlash({ agent: "personal", feature: "thinking", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-ux-feature", { agent: "personal", feature: "thinking", state: "status" });
  });

  it("status says whether the value came from /clawcode-ux or from config", async () => {
    const fromOverride = await handleUxSlash({ agent: "personal", feature: "thinking", state: "status", sendIpc: ipc({ source: "override" }) });
    expect(fromOverride).toBe("Live thinking **on** for **personal** (set with /clawcode-ux)\nTakes effect on the next turn.");
    const fromConfig = await handleUxSlash({ agent: "personal", feature: "thinking", sendIpc: ipc({ enabled: false, source: "config" }) });
    expect(fromConfig).toBe("Live thinking **off** for **personal** (from config)\nTakes effect on the next turn.");
  });

  it("reset sends state reset and reports the value config now gives, and its source", async () => {
    const send = ipc({ state: "reset", enabled: true, source: "config" });
    const reply = await handleUxSlash({ agent: "personal", feature: "thinking", state: "reset", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-ux-feature", { agent: "personal", feature: "thinking", state: "reset" });
    expect(reply).toBe("Live thinking reset for **personal** — now **on** (from config).\nTakes effect on the next turn.");
    const off = await handleUxSlash({
      agent: "personal",
      feature: "thinking",
      state: "reset",
      sendIpc: ipc({ state: "reset", enabled: false, source: "config", configEnabled: false }),
    });
    expect(off).toBe("Live thinking reset for **personal** — now **off** (from config).\nTakes effect on the next turn.");
    expect(off).not.toContain("kept across restarts");
  });

  it("a feature this build does not consume says it is saved but unused", async () => {
    const send = ipc({ feature: "researchSubagents", state: "on", source: "override", applies: "not-yet-available" });
    const reply = await handleUxSlash({ agent: "personal", feature: "research", state: "on", sendIpc: send });
    expect(reply).toBe("Research subagents **on** for **personal** — kept across restarts.\nSaved, but this build does not use it yet.");
  });

  it("999.172 — says restart pending when the running session still differs", async () => {
    const send = ipc({ feature: "promptSuggestions", state: "on", source: "override", applies: "restart", restartPending: true });
    const reply = await handleUxSlash({ agent: "personal", feature: "suggestions", state: "on", sendIpc: send });
    expect(reply).toBe(
      "Prompt suggestions **on** for **personal** — kept across restarts.\nRestart pending: takes effect after the agent restarts (clawcode restart personal).",
    );
  });

  it("999.172 — says the running session already matches when it does", async () => {
    const send = ipc({ feature: "promptSuggestions", state: "status", source: "config", applies: "restart", restartPending: false });
    const reply = await handleUxSlash({ agent: "personal", feature: "suggestions", sendIpc: send });
    expect(reply).toContain("The running session already matches.");
  });

  it("a session-start feature says it applies after the agent restarts", async () => {
    const send = ipc({ agent: "projects", feature: "researchSubagents", state: "on", source: "override", applies: "restart" });
    const reply = await handleUxSlash({ agent: "projects", feature: "research", state: "on", sendIpc: send });
    expect(reply).toBe(
      "Research subagents **on** for **projects** — kept across restarts.\nTakes effect after the agent restarts (clawcode restart projects).",
    );
  });

  it("daemon errors render as `ux: <error>`", async () => {
    const send = vi.fn(async () => ({ error: "unknown agent (not in config)" }));
    expect(await handleUxSlash({ agent: "x", feature: "thinking", state: "on", sendIpc: send })).toBe("ux: unknown agent (not in config)");
  });

  it("a malformed daemon response renders as an error, not a crash", async () => {
    expect(await handleUxSlash({ agent: "x", feature: "thinking", sendIpc: vi.fn(async () => null) })).toMatch(/^ux: /);
    expect(await handleUxSlash({ agent: "x", feature: "thinking", sendIpc: vi.fn(async () => "nope") })).toMatch(/^ux: /);
  });

  it("an unexpected feature key in the response falls back to the raw key, not a prototype member", async () => {
    const reply = await handleUxSlash({ agent: "personal", feature: "x", sendIpc: ipc({ feature: "constructor" }) });
    expect(reply.startsWith("constructor **on**")).toBe(true);
    expect(reply).not.toContain("function");
  });

  it("replies are capped at 1900 characters", async () => {
    const reply = await handleUxSlash({ agent: "personal", feature: "thinking", sendIpc: ipc({ agent: "a".repeat(5000) }) });
    expect(reply.length).toBeLessThanOrEqual(1900);
  });

  it("no reply shape contains an emoji or pictographic character", async () => {
    const shapes: Array<{ state?: string; result: IpcResult }> = [
      { state: "on", result: { state: "on", enabled: true, source: "override" } },
      { state: "off", result: { state: "off", enabled: false, source: "override" } },
      { state: "status", result: { source: "override" } },
      { state: "reset", result: { state: "reset", enabled: true, source: "config" } },
      { state: "reset", result: { state: "reset", enabled: false, source: "config" } },
      { result: { source: "config", enabled: false } },
      { state: "on", result: { state: "on", applies: "restart", feature: "researchSubagents" } },
      { state: "on", result: { state: "on", applies: "not-yet-available", feature: "promptSuggestions" } },
      { result: { agent: "a".repeat(5000) } },
    ];
    const replies: string[] = [];
    for (const { state, result } of shapes) {
      replies.push(await handleUxSlash({ agent: "personal", feature: "thinking", state, sendIpc: ipc(result) }));
    }
    replies.push(await handleUxSlash({ agent: "x", feature: "thinking", sendIpc: vi.fn(async () => ({ error: "boom" })) }));
    for (const reply of replies) expect(PICTOGRAPHIC.test(reply)).toBe(false);
  });
});
