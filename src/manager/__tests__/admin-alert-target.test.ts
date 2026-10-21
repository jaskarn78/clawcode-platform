import { describe, it, expect, vi } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import {
  ADMIN_AGENT_CANONICAL_NAME,
  normalizeAgentName,
  resolveAdminAlertTarget,
  selectAdminAlertLeg,
  deliverAdminAlert,
  type AdminAlertTargetSources,
} from "../admin-alert-target.js";

/**
 * INC-2026-08-08 — these pin the bug that made every daemon alert invisible.
 *
 * `postToAdminClawdy` looked up `resolvedAgents.find(a => a.name === "admin-clawdy")`
 * while the production agent is named `Admin Clawdy`. The lookup never matched, so
 * the bot-direct leg was dead code and every alert fell through to a pino line —
 * for months, across MemoryGuard, model-monitor, and ingest alerts.
 */

/** Silent pino instance — same shape as the sibling secrets-resolver tests. */
function silentLog(): pino.Logger {
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  return pino({ level: "silent" }, sink);
}

function sources(over: Partial<AdminAlertTargetSources> = {}): AdminAlertTargetSources {
  return {
    agents: [],
    agentToChannels: new Map<string, string[]>(),
    envChannelId: undefined,
    fallbackChannelId: "FALLBACK_CHANNEL",
    ...over,
  };
}

describe("normalizeAgentName", () => {
  it("maps the real production spelling onto the canonical name", () => {
    // THE bug: "Admin Clawdy" (config) vs "admin-clawdy" (code literal).
    expect(normalizeAgentName("Admin Clawdy")).toBe(ADMIN_AGENT_CANONICAL_NAME);
  });

  it("is tolerant of spacing/casing variants", () => {
    for (const variant of ["admin-clawdy", "ADMIN CLAWDY", "Admin  Clawdy"]) {
      expect(normalizeAgentName(variant)).toBe(ADMIN_AGENT_CANONICAL_NAME);
    }
  });

  it("does not collapse unrelated agents onto the admin identity", () => {
    expect(normalizeAgentName("shopping")).not.toBe(ADMIN_AGENT_CANONICAL_NAME);
  });
});

describe("resolveAdminAlertTarget", () => {
  it("resolves the channel from the ROUTING TABLE for the real agent name", () => {
    // The premise the old code gave up on ("admin-clawdy doesn't expose its
    // channelId on the resolved config") was false — the channel lives in the
    // routing table, which is how every other alert path resolves it.
    const t = resolveAdminAlertTarget(
      sources({
        agents: [{ name: "Admin Clawdy", channels: [] }],
        agentToChannels: new Map([["Admin Clawdy", ["CHAN_ROUTING"]]]),
      }),
    );
    expect(t.channelId).toBe("CHAN_ROUTING");
    expect(t.channelSource).toBe("routing-table");
    expect(t.agentName).toBe("Admin Clawdy");
  });

  it("falls back to the agent config channel when routing has none", () => {
    const t = resolveAdminAlertTarget(
      sources({ agents: [{ name: "Admin Clawdy", channels: ["CHAN_CFG"] }] }),
    );
    expect(t.channelId).toBe("CHAN_CFG");
    expect(t.channelSource).toBe("agent-config");
  });

  it("lets the env override WIN over the routing table", () => {
    // Ordering matters: behind the routing table the override is unreachable on
    // any fleet that has the admin agent configured, defeating its only purpose
    // (re-pointing alerts mid-incident without a config deploy).
    const t = resolveAdminAlertTarget(
      sources({
        agents: [{ name: "Admin Clawdy", channels: ["CHAN_CFG"] }],
        agentToChannels: new Map([["Admin Clawdy", ["CHAN_ROUTING"]]]),
        envChannelId: "CHAN_ENV",
      }),
    );
    expect(t.channelId).toBe("CHAN_ENV");
    expect(t.channelSource).toBe("env-override");
  });

  it("reports the deployment constant when no admin agent matches", () => {
    // This is the DEGRADED state the boot sentinel must flag: delivery looks
    // routable, but the channel is a guess.
    const t = resolveAdminAlertTarget(sources({ agents: [{ name: "shopping", channels: ["X"] }] }));
    expect(t.channelId).toBe("FALLBACK_CHANNEL");
    expect(t.channelSource).toBe("deployment-constant");
    expect(t.agentName).toBeUndefined();
  });
});

describe("selectAdminAlertLeg", () => {
  const target = {
    agentName: "Admin Clawdy",
    channelId: "CHAN",
    channelSource: "routing-table" as const,
  };

  it("prefers the webhook when one is configured", () => {
    const leg = selectAdminAlertLeg({
      webhook: { hasWebhook: () => true, send: vi.fn() },
      botDirect: { sendText: vi.fn() },
      target,
    });
    expect(leg).toBe("webhook");
  });

  it("uses bot-direct when no webhook exists — the production case", () => {
    const leg = selectAdminAlertLeg({
      webhook: { hasWebhook: () => false, send: vi.fn() },
      botDirect: { sendText: vi.fn() },
      target,
    });
    expect(leg).toBe("bot-direct");
  });

  it("is pino-only when nothing can send", () => {
    const leg = selectAdminAlertLeg({ webhook: null, botDirect: null, target });
    expect(leg).toBe("pino-only");
  });
});

describe("deliverAdminAlert", () => {
  const target = {
    agentName: "Admin Clawdy",
    channelId: "CHAN",
    channelSource: "routing-table" as const,
  };

  it("actually sends via bot-direct when there is no webhook (the regression)", async () => {
    const sendText = vi.fn().mockResolvedValue("msg-1");
    const leg = await deliverAdminAlert("boom", {
      webhook: { hasWebhook: () => false, send: vi.fn() },
      botDirect: { sendText },
      target,
      log: silentLog(),
    });
    expect(sendText).toHaveBeenCalledWith("CHAN", "boom");
    expect(leg).toBe("bot-direct");
  });

  it("never throws when delivery fails — an alert must not break its caller", async () => {
    const log = silentLog();
    const warnSpy = vi.spyOn(log, "warn");
    const leg = await deliverAdminAlert("boom", {
      webhook: null,
      botDirect: {
        sendText: vi.fn().mockRejectedValue(new Error("discord 500")),
      },
      target,
      log,
    });
    // Degrades to the pino leg instead of throwing into the caller's tick.
    expect(leg).toBe("pino-only");
    expect(warnSpy).toHaveBeenCalled();
  });
});

/**
 * 999.147 — components on the alert. Only the WEBHOOK leg can carry them, so
 * the tests that matter are the ones where it cannot: the button has to be
 * the bonus, never the payload.
 */
describe("deliverAdminAlert — relief button components", () => {
  const target = {
    agentName: "admin-clawdy",
    channelId: "chan-1",
    channelSource: "routing-table" as const,
  };
  const row = { type: 1, components: [{ type: 2, custom_id: "memrel:k:1:2:3" }] };

  it("attaches components to the LAST message id of a chunked send", () => {
    // WebhookManager.send splits long content, so a page that chunks would
    // otherwise put the button on a fragment nobody reads to.
    const edits: { messageId: string; components: readonly unknown[] }[] = [];
    const webhook = {
      hasWebhook: () => true,
      send: async () => ({ messageIds: ["m1", "m2", "m3"] }),
      editMessageComponents: async (
        _a: string,
        messageId: string,
        components: readonly unknown[],
      ) => {
        edits.push({ messageId, components });
      },
    };
    return deliverAdminAlert(
      "pressure",
      { webhook, botDirect: null, target, log: silentLog() },
      { components: [row] },
    ).then((leg) => {
      expect(leg).toBe("webhook");
      expect(edits).toHaveLength(1);
      expect(edits[0].messageId).toBe("m3");
      expect(edits[0].components).toEqual([row]);
    });
  });

  it("never attaches anything when the caller passes no components", async () => {
    const edit = vi.fn();
    const webhook = {
      hasWebhook: () => true,
      send: async () => ({ messageIds: ["m1"] }),
      editMessageComponents: edit,
    };
    await deliverAdminAlert("plain", {
      webhook,
      botDirect: null,
      target,
      log: silentLog(),
    });
    expect(edit).not.toHaveBeenCalled();
  });

  it("a failed component edit still counts as delivered — the text landed", async () => {
    const webhook = {
      hasWebhook: () => true,
      send: async () => ({ messageIds: ["m1"] }),
      editMessageComponents: async () => {
        throw new Error("403 Forbidden");
      },
    };
    const leg = await deliverAdminAlert(
      "pressure",
      { webhook, botDirect: null, target, log: silentLog() },
      { components: [row] },
    );
    expect(leg).toBe("webhook");
  });

  it("bot-direct fallback delivers the TEXT with no button and no throw", async () => {
    // The button is structurally impossible here. This is exactly why every
    // page names its CLI equivalent in the message body.
    const sent: string[] = [];
    const leg = await deliverAdminAlert(
      "pressure · clawcode mem relieve --pid 42",
      {
        webhook: null,
        botDirect: {
          sendText: async (_c: string, content: string) => {
            sent.push(content);
            return "m1";
          },
        },
        target,
        log: silentLog(),
      },
      { components: [row] },
    );
    expect(leg).toBe("bot-direct");
    expect(sent[0]).toContain("clawcode mem relieve --pid 42");
  });

  it("a webhook without the editor degrades to text rather than throwing", async () => {
    // Structural typing means an older/partial WebhookManager can arrive here.
    const webhook = {
      hasWebhook: () => true,
      send: async () => ({ messageIds: ["m1"] }),
    };
    const leg = await deliverAdminAlert(
      "pressure",
      { webhook, botDirect: null, target, log: silentLog() },
      { components: [row] },
    );
    expect(leg).toBe("webhook");
  });
});
