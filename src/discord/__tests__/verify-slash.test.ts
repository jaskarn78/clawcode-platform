/**
 * 999.63d/7 — `/clawcode-verify` argument handling and reply shaping.
 *
 * These exist because the store/profile unit tests could all pass while
 * the command was DEAD: the generic CONTROL_COMMANDS fallback forwards
 * only `{name}`, so mode/profile/action never reached the daemon until
 * the command got its own dispatch branch. That is a dispatch-layer bug
 * no store test can see.
 */
import { describe, expect, it, vi } from "vitest";

import { handleVerifySlash } from "../slash-commands.js";

function ipc(result: unknown) {
  return vi.fn(async () => result);
}

describe("handleVerifySlash", () => {
  it("forwards mode and profile as IPC params", async () => {
    const send = ipc({ agent: "fin-client", override: { mode: "topic" } });
    await handleVerifySlash({
      agent: "fin-client",
      mode: "topic",
      profile: "finance",
      sendIpc: send,
    });
    expect(send).toHaveBeenCalledWith("set-verification", {
      agent: "fin-client",
      mode: "topic",
      profile: "finance",
    });
  });

  it("omits absent options rather than sending undefined", async () => {
    const send = ipc({ agent: "a", override: { mode: "always" } });
    await handleVerifySlash({ agent: "a", mode: "always", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-verification", {
      agent: "a",
      mode: "always",
    });
  });

  it("a bare invocation reads as status, not an error", async () => {
    const send = ipc({
      agent: "a",
      override: null,
      effective: { enabled: true, mode: "auto", profile: "finance" },
    });
    const reply = await handleVerifySlash({ agent: "a", sendIpc: send });
    expect(send).toHaveBeenCalledWith("set-verification", {
      agent: "a",
      action: "status",
    });
    expect(reply).toContain("auto");
  });

  it("status says whether the value came from an override or config", async () => {
    const fromCfg = await handleVerifySlash({
      agent: "a",
      action: "status",
      sendIpc: ipc({
        agent: "a",
        override: null,
        effective: { enabled: true, mode: "auto", profile: "finance" },
      }),
    });
    expect(fromCfg).toContain("config");

    const fromOverride = await handleVerifySlash({
      agent: "a",
      action: "status",
      sendIpc: ipc({
        agent: "a",
        override: { mode: "topic" },
        effective: { enabled: true, mode: "topic", profile: "legal" },
      }),
    });
    expect(fromOverride).toContain("override");
    expect(fromOverride).toContain("legal");
  });

  it("says so plainly when the trail is off, instead of implying it works", async () => {
    const reply = await handleVerifySlash({
      agent: "quiet-agent",
      action: "status",
      sendIpc: ipc({
        agent: "quiet-agent",
        override: null,
        effective: { enabled: false, mode: "auto", profile: "finance" },
      }),
    });
    expect(reply).toContain("off");
    expect(reply).toContain("streamStatus");
  });

  it("reports a reset", async () => {
    const reply = await handleVerifySlash({
      agent: "a",
      action: "reset",
      sendIpc: ipc({ agent: "a", override: null, reset: true }),
    });
    expect(reply).toContain("cleared");
  });

  it("surfaces a daemon error rather than throwing at the operator", async () => {
    const reply = await handleVerifySlash({
      agent: "a",
      mode: "nonsense",
      sendIpc: ipc({ error: "invalid mode 'nonsense'" }),
    });
    expect(reply).toContain("invalid mode");
  });
});
