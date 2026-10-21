/**
 * 999.147 WS-2 — the Discord surface of the relief action.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  buildReliefRow,
  encodeContainerReliefId,
  handleContainerReliefButton,
  handleReliefButton,
  parseContainerReliefId,
  reliefButtonLabel,
  reliefMessageSuffix,
  worthOffering,
  MEMREL_PREFIX,
} from "../memory-relief-button.js";
import { parseReliefId, type ReliefProcess } from "../../manager/memory-relief.js";

const NOW = 1_700_000_000_000;
const offer = {
  pid: 574_875,
  comm: "ugrep",
  anonSwapMb: 6000,
  startTicks: 998_877,
  issuedAtMs: NOW,
};

const silent = () => pino({ level: "silent" });

describe("the offer", () => {
  it("names the action and its subject — never a bare 'fix it'", () => {
    // The operator clicking this is authorising a SIGKILL; they should see
    // exactly what dies before they click.
    const label = reliefButtonLabel(offer);
    expect(label).toContain("Kill");
    expect(label).toContain("ugrep");
    expect(label).toContain("574875");
    expect(label.length).toBeLessThanOrEqual(80); // Discord's label ceiling
  });

  it("builds a row whose customId round-trips back to the target", () => {
    const row = buildReliefRow(offer) as {
      components: { custom_id: string }[];
    };
    const id = row.components[0].custom_id;
    expect(id.startsWith(MEMREL_PREFIX)).toBe(true);
    expect(parseReliefId(id)).toMatchObject({
      pid: offer.pid,
      startTicks: offer.startTicks,
    });
  });

  it("the text suffix carries the CLI equivalent, for the legs with no button", () => {
    const suffix = reliefMessageSuffix(offer);
    expect(suffix).toContain("clawcode mem relieve --pid 574875");
    expect(suffix).toContain("ugrep");
  });

  it("declines to offer a button for a trivial 'top consumer'", () => {
    // A button that frees 40MB trains the operator to distrust the ones that
    // matter.
    expect(worthOffering(40)).toBe(false);
    expect(worthOffering(6000)).toBe(true);
  });
});

describe("handleReliefButton", () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const replies: { content: string; flags?: number }[] = [];
    const kill = vi.fn();
    const interaction = {
      customId: `memrel:k:574875:998877:${Math.floor(NOW / 1000)}`,
      user: { id: "42" },
      reply: async (opts: { content: string; flags?: number }) => {
        replies.push(opts);
      },
    };
    const deps = {
      readProc: (): ReliefProcess => ({
        pid: 574_875,
        comm: "ugrep",
        startTicks: 998_877,
        anonSwapMb: 6000,
      }),
      inCgroup: () => true,
      kill,
      daemonPid: 1000,
      now: () => NOW,
      log: silent(),
      audit: async () => {},
      ...over,
    };
    return { interaction, deps: deps as never, replies, kill };
  };

  it("kills and confirms, ephemerally", async () => {
    const { interaction, deps, replies, kill } = harness();
    await handleReliefButton(interaction, deps);
    expect(kill).toHaveBeenCalledWith(574_875);
    expect(replies).toHaveLength(1);
    expect(replies[0].content).toContain("Killed");
    // Ephemeral: a refusal reason must not add noise to the very channel the
    // operator complained about.
    expect(replies[0].flags).toBeDefined();
  });

  it("explains a refusal instead of silently doing nothing", async () => {
    const { interaction, deps, replies, kill } = harness({
      readProc: () => ({
        pid: 574_875,
        comm: "claude",
        startTicks: 1, // recycled
        anonSwapMb: 300,
      }),
    });
    await handleReliefButton(interaction, deps);
    expect(kill).not.toHaveBeenCalled();
    expect(replies[0].content).toContain("recycled");
  });

  it("ignores a customId that is not ours", async () => {
    const { deps, replies, kill } = harness();
    await handleReliefButton(
      {
        customId: "memrel:garbage",
        user: { id: "42" },
        reply: async (opts: { content: string }) => {
          replies.push(opts);
        },
      } as never,
      deps,
    );
    expect(kill).not.toHaveBeenCalled();
    expect(replies[0].content).toContain("malformed");
  });

  it("never throws, even when an injected dep does", async () => {
    // Registered on interactionCreate, where an unhandled rejection takes the
    // whole daemon — and therefore the entire fleet — down.
    const { interaction, deps, replies } = harness({
      readProc: () => {
        throw new Error("proc read exploded");
      },
    });
    await expect(handleReliefButton(interaction, deps)).resolves.toBeUndefined();
    expect(replies[0].content).toContain("failed");
  });

  it("survives an expired interaction token without throwing", async () => {
    const { deps, kill } = harness();
    await expect(
      handleReliefButton(
        {
          customId: `memrel:k:574875:998877:${Math.floor(NOW / 1000)}`,
          user: { id: "42" },
          reply: async () => {
            throw new Error("Unknown interaction");
          },
        } as never,
        deps,
      ),
    ).resolves.toBeUndefined();
    // The kill still happened — the reply failing must not hide that.
    expect(kill).toHaveBeenCalled();
  });
});

describe("the Unraid container button", () => {
  it("round-trips through encode → parse", () => {
    const id = encodeContainerReliefId("state-contract-transcribe", NOW);
    expect(parseContainerReliefId(id)).toEqual({
      container: "state-contract-transcribe",
      issuedAtMs: Math.floor(NOW / 1000) * 1000,
    });
  });

  it("refuses a name that could reach the shell, at PARSE time", () => {
    // Defence in depth: the action validates too, but a customId carrying a
    // metacharacter should never get as far as being a container name.
    expect(parseContainerReliefId("memrel:d:$(id):1700000000")).toBeNull();
    expect(parseContainerReliefId("memrel:d:../etc:1700000000")).toBeNull();
    expect(parseContainerReliefId("memrel:d::1700000000")).toBeNull();
    expect(parseContainerReliefId("memrel:d:ok:notanumber")).toBeNull();
    expect(parseContainerReliefId("memrel:k:1:2:3")).toBeNull(); // the kill id
  });

  it("stays inside the customId ceiling for a long container name", () => {
    const id = encodeContainerReliefId("a".repeat(62), NOW);
    expect(id.length).toBeLessThan(100);
  });

  it("restarts, and reports it", async () => {
    const cmds: string[] = [];
    const replies: { content: string }[] = [];
    await handleContainerReliefButton(
      {
        customId: encodeContainerReliefId("frigate", NOW),
        user: { id: "42" },
        reply: async (o: { content: string }) => {
          replies.push(o);
        },
      } as never,
      {
        ssh: async (c: string) => {
          cmds.push(c);
          return "";
        },
        log: silent(),
        audit: async () => {},
        now: () => NOW,
      } as never,
    );
    expect(cmds).toEqual(["docker restart frigate"]);
    expect(replies[0].content).toContain("Restarted");
  });

  it("refuses an EXPIRED button instead of restarting on stale information", async () => {
    const ssh = vi.fn();
    const replies: { content: string }[] = [];
    await handleContainerReliefButton(
      {
        customId: encodeContainerReliefId("frigate", NOW - 31 * 60_000),
        user: { id: "42" },
        reply: async (o: { content: string }) => {
          replies.push(o);
        },
      } as never,
      {
        ssh: ssh as never,
        log: silent(),
        audit: async () => {},
        now: () => NOW,
      } as never,
    );
    expect(ssh).not.toHaveBeenCalled();
    expect(replies[0].content).toContain("expired");
  });

  it("never throws when the ssh dep does", async () => {
    const replies: { content: string }[] = [];
    await expect(
      handleContainerReliefButton(
        {
          customId: encodeContainerReliefId("frigate", NOW),
          user: { id: "42" },
          reply: async (o: { content: string }) => {
            replies.push(o);
          },
        } as never,
        {
          ssh: async () => {
            throw new Error("host unreachable");
          },
          log: silent(),
          audit: async () => {},
          now: () => NOW,
        } as never,
      ),
    ).resolves.toBeUndefined();
    expect(replies[0].content).toContain("host unreachable");
  });
});
