/**
 * 999.147 WS-2 — relief button safety.
 *
 * This is the only path in ClawCode where a Discord click SIGKILLs a process,
 * so the interesting tests are all refusals. The pid-reuse case is the one
 * that matters most: a box spawning hundreds of short-lived claude/mcp
 * children an hour WILL recycle a pid inside the button's 30-minute life.
 */
import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { readFileSync } from "node:fs";
import {
  decideRelief,
  encodeReliefId,
  executeRelief,
  parseReliefId,
  readReliefProc,
  RELIEF_TTL_MS,
  type ReliefAuditRow,
  type ReliefProcess,
} from "../memory-relief.js";

const NOW = 1_700_000_000_000;
const DAEMON_PID = 1000;

const target = (over: Partial<ReturnType<typeof baseTarget>> = {}) => ({
  ...baseTarget(),
  ...over,
});
function baseTarget() {
  return { pid: 574_875, startTicks: 998_877, issuedAtMs: NOW - 60_000 };
}

const liveProc = (over: Partial<ReliefProcess> = {}): ReliefProcess => ({
  pid: 574_875,
  comm: "ugrep",
  startTicks: 998_877,
  anonSwapMb: 6000,
  ...over,
});

const decide = (over: Record<string, unknown> = {}) =>
  decideRelief({
    target: target(),
    nowMs: NOW,
    live: liveProc(),
    inCgroup: true,
    daemonPid: DAEMON_PID,
    stillFatMb: 512,
    ...over,
  } as never);

describe("customId round-trip", () => {
  it("survives encode → parse", () => {
    const t = target();
    const parsed = parseReliefId(encodeReliefId(t));
    expect(parsed).toEqual({
      pid: t.pid,
      startTicks: t.startTicks,
      // second resolution, so the ms remainder is dropped by design
      issuedAtMs: Math.floor(t.issuedAtMs / 1000) * 1000,
    });
  });

  it("stays inside Discord's 100-char customId ceiling", () => {
    const id = encodeReliefId({
      pid: 4_194_304, // kernel pid_max ceiling
      startTicks: 9_999_999_999,
      issuedAtMs: NOW,
    });
    expect(id.length).toBeLessThan(100);
  });

  it("rejects anything that is not ours, and anything malformed", () => {
    expect(parseReliefId("acctlink:approve:123")).toBeNull();
    expect(parseReliefId("trn:period:7d")).toBeNull();
    expect(parseReliefId("memrel:k:1:2")).toBeNull(); // too few parts
    expect(parseReliefId("memrel:x:1:2:3")).toBeNull(); // unknown action
    expect(parseReliefId("memrel:k:abc:2:3")).toBeNull(); // non-numeric
    expect(parseReliefId("memrel:k:1:2:3")).toBeNull(); // pid <= 1 (init)
    expect(parseReliefId("memrel:k:500:0:3")).toBeNull(); // unknown identity
  });
});

describe("decideRelief — refusals, most dangerous first", () => {
  it("refuses the daemon unconditionally, even inside the TTL", () => {
    const d = decide({ target: target({ pid: DAEMON_PID }) });
    expect(d).toMatchObject({ ok: false, refusal: "is-daemon" });
  });

  it("refuses the daemon even before checking whether it still exists", () => {
    // Ordering matters: `live: null` must not short-circuit to "gone" and
    // hide the fact that someone minted a button for the daemon's pid.
    const d = decide({ target: target({ pid: DAEMON_PID }), live: null });
    expect(d).toMatchObject({ ok: false, refusal: "is-daemon" });
  });

  it("refuses an expired button", () => {
    const d = decide({
      target: target({ issuedAtMs: NOW - RELIEF_TTL_MS - 1 }),
    });
    expect(d).toMatchObject({ ok: false, refusal: "expired" });
    expect((d as { detail: string }).detail).toMatch(/expired/);
  });

  it("refuses when the process is already gone", () => {
    expect(decide({ live: null })).toMatchObject({
      ok: false,
      refusal: "gone",
    });
  });

  it("REFUSES A RECYCLED PID — the guard this whole module exists for", () => {
    // Same pid, different start time: the kernel handed 574875 to something
    // else after the page was sent. Killing it would take out an unrelated
    // process, quite possibly a live agent.
    const d = decide({
      live: liveProc({ startTicks: 1_000_001, comm: "claude" }),
    });
    expect(d).toMatchObject({ ok: false, refusal: "identity-mismatch" });
    expect((d as { detail: string }).detail).toContain("recycled");
  });

  it("refuses a pid outside the clawcode cgroup", () => {
    // Belt-and-braces against ever reaching a system service.
    expect(decide({ inCgroup: false })).toMatchObject({
      ok: false,
      refusal: "not-in-cgroup",
    });
  });

  it("refuses when the balloon already deflated", () => {
    const d = decide({ live: liveProc({ anonSwapMb: 40 }) });
    expect(d).toMatchObject({ ok: false, refusal: "recovered" });
  });

  it("allows the one case that is actually the named offender", () => {
    expect(decide()).toMatchObject({ ok: true });
  });
});

describe("executeRelief", () => {
  const harness = (over: Record<string, unknown> = {}) => {
    const rows: ReliefAuditRow[] = [];
    const kill = vi.fn();
    const deps = {
      readProc: () => liveProc(),
      inCgroup: () => true,
      kill,
      daemonPid: DAEMON_PID,
      now: () => NOW,
      log: pino({ level: "silent" }),
      audit: async (row: ReliefAuditRow) => {
        rows.push(row);
      },
      ...over,
    };
    return { deps: deps as never, rows, kill };
  };

  it("kills, reports the freed memory, and audits the actor", async () => {
    const { deps, rows, kill } = harness();
    const out = await executeRelief(target(), "discord:12345", deps);
    expect(out.ok).toBe(true);
    expect(kill).toHaveBeenCalledWith(574_875);
    expect(out.message).toContain("ugrep");
    expect(out.message).toContain("6000MB");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "killed",
      actor: "discord:12345",
      pid: 574_875,
    });
  });

  it("does NOT kill on a refusal, and audits the reason", async () => {
    const { deps, rows, kill } = harness({
      readProc: () => liveProc({ startTicks: 42 }),
    });
    const out = await executeRelief(target(), "discord:12345", deps);
    expect(out.ok).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({
      outcome: "refused",
      refusal: "identity-mismatch",
    });
  });

  it("surfaces a failed kill instead of claiming success", async () => {
    const { deps, rows } = harness({
      kill: () => {
        throw new Error("EPERM");
      },
    });
    const out = await executeRelief(target(), "cli:owner_a", deps);
    expect(out.ok).toBe(false);
    expect(out.message).toContain("EPERM");
    expect(rows[0]).toMatchObject({ outcome: "kill-failed" });
  });

  it("a broken audit sink never turns a successful kill into an error", async () => {
    // The action already happened; reporting it as failed would be a lie the
    // operator acts on.
    const { deps, kill } = harness({
      audit: async () => {
        throw new Error("disk full");
      },
    });
    const out = await executeRelief(target(), "cli:owner_a", deps);
    expect(out.ok).toBe(true);
    expect(kill).toHaveBeenCalled();
  });
});

describe("readReliefProc — against this very process", () => {
  it("parses a real /proc/<pid>/stat starttime", () => {
    // An off-by-one in the field index fails SILENTLY into permanent
    // "identity-mismatch", which reads as a broken feature rather than a bug.
    // Pinning it against a real /proc entry is the only way to catch that.
    const me = readReliefProc(process.pid);
    expect(me).not.toBeNull();
    expect(me?.pid).toBe(process.pid);
    expect(me?.startTicks).toBeGreaterThan(0);

    // Cross-check against an independent parse of the same file.
    const raw = readFileSync(`/proc/${process.pid}/stat`, "utf-8");
    const expected = Number(
      raw.slice(raw.lastIndexOf(")") + 2).split(" ")[19],
    );
    expect(me?.startTicks).toBe(expected);
    // And it must be stable across reads — that is what makes it an identity.
    expect(readReliefProc(process.pid)?.startTicks).toBe(me?.startTicks);
  });

  it("returns null for a pid that does not exist", () => {
    expect(readReliefProc(4_194_303)).toBeNull();
  });
});
