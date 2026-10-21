/**
 * Phase 999.164 — `/clawcode-quick`: argument handling and reply shaping,
 * without a Discord client.
 */
import { describe, expect, it, vi } from "vitest";
import { handleQuickSlash } from "../slash-commands.js";
import { CONTROL_COMMANDS } from "../slash-types.js";

const MAP = "### personal\n- **Quick lane answers:** greetings, thanks, laughter, and standalone general-knowledge questions that avoid everything below.";

function ipc(result: Record<string, unknown>) {
  return vi.fn(async () => ({ agent: "personal", enabled: true, source: "config", model: "haiku", map: MAP, ...result }));
}

describe("/clawcode-quick", () => {
  it("is an admin-only control command routed to set-fast-lane", () => {
    const cmd = CONTROL_COMMANDS.find((c) => c.name === "clawcode-quick");
    expect(cmd?.ipcMethod).toBe("set-fast-lane");
    expect(cmd?.control).toBe(true);
    expect(cmd?.defaultMemberPermissions).toBe("0");
    expect(cmd?.options.map((o) => o.name)).toEqual(["lane", "agent"]);
  });

  it("a bare invocation is a status read that shows the agent's quick-lane map", async () => {
    const send = ipc({});
    const reply = await handleQuickSlash({ agent: "personal", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-fast-lane", { agent: "personal", lane: "status" });
    expect(reply).toContain("Quick lane **on** for **personal** (from config, model haiku)");
    expect(reply).toContain("### personal");
  });

  it("off persists and says how to undo it; no map when the lane is off", async () => {
    const send = ipc({ agent: "fin-client", enabled: false, source: "override" });
    const reply = await handleQuickSlash({ agent: "fin-client", lane: "off", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-fast-lane", { agent: "fin-client", lane: "off" });
    expect(reply).toContain("Quick lane **off** for **fin-client** — kept across restarts.");
    expect(reply).toContain("/clawcode-quick lane:reset");
    expect(reply).not.toContain("###");
  });

  it("reset reports the config state it fell back to", async () => {
    const reply = await handleQuickSlash({ agent: "personal", lane: "reset", sendIpc: ipc({}) });
    expect(reply).toBe(`Quick lane override cleared for **personal** — now **on** from config.\n\n${MAP}`);
  });

  it("daemon errors surface as text; long maps stay under Discord's limit", async () => {
    expect(await handleQuickSlash({ agent: "x", sendIpc: vi.fn(async () => ({ error: "unknown agent 'x'" })) })).toBe("quick lane: unknown agent 'x'");
    const reply = await handleQuickSlash({ agent: "personal", sendIpc: ipc({ map: "y".repeat(5000) }) });
    expect(reply.length).toBeLessThanOrEqual(1900);
  });
});
