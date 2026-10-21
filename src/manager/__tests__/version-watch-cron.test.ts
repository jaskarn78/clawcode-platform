import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  fileStateStore,
  pruneResolved,
  registerVersionWatchCron,
  runVersionWatchTick,
  VERSION_WATCH_CRON_PATTERN,
  type VersionWatchDeps,
} from "../version-watch-cron.js";
import type { RuntimeTruth, VersionWatchState } from "../version-watch.js";

const runtime: RuntimeTruth = {
  sdkVersion: "0.3.282",
  sdkClaudeCodeVersion: "2.1.282",
  binaryVersion: "2.1.282 (Claude Code)",
  source: "sdk-bundled",
  pin: "/x/claude",
  error: null,
};

function deps(over: Partial<VersionWatchDeps> = {}): VersionWatchDeps & { posts: string[]; state: { current: VersionWatchState } } {
  const posts: string[] = [];
  const state = { current: { surfaced: {} } as VersionWatchState };
  return {
    posts,
    state,
    getRuntime: () => runtime,
    getHighestFloor: () => "2.1.280",
    fetchJson: async (url) =>
      url.endsWith("/latest") ? { version: "0.3.283", claudeCodeVersion: "2.1.283" } : { time: { "0.3.283": "2026-09-23T00:00:00Z" } },
    readState: () => state.current,
    writeState: (s) => {
      state.current = s;
    },
    postToAdminClawdy: async (m) => {
      posts.push(m);
    },
    now: () => Date.parse("2026-09-25T00:00:00Z"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ...over,
  };
}

describe("runVersionWatchTick", () => {
  it("posts a new pair once, then stays silent on the next tick", async () => {
    const d = deps();
    expect((await runVersionWatchTick(d)).posted).toBe(1);
    expect(d.posts[0]).toContain("0.3.283");
    expect((await runVersionWatchTick(d)).posted).toBe(0);
    expect(d.posts).toHaveLength(1);
  });

  it("silent when prod is on the latest pair", async () => {
    const d = deps({ fetchJson: async () => ({ version: "0.3.282", claudeCodeVersion: "2.1.282" }) });
    expect((await runVersionWatchTick(d)).posted).toBe(0);
    expect(d.posts).toEqual([]);
  });

  it("a registry outage is not a crash and still reports local skew", async () => {
    const d = deps({
      fetchJson: async () => {
        throw new Error("ENOTFOUND");
      },
      getRuntime: () => ({ ...runtime, binaryVersion: "2.1.283" }),
    });
    expect((await runVersionWatchTick(d)).posted).toBe(1);
    expect(d.posts[0]).toContain("skew");
  });

  it("does not mark surfaced when the post fails (retried next tick)", async () => {
    const d = deps({
      postToAdminClawdy: async () => {
        throw new Error("discord down");
      },
    });
    await expect(runVersionWatchTick(d)).rejects.toThrow("discord down");
    expect(d.state.current.surfaced).toEqual({});
  });
});

describe("pruneResolved", () => {
  it("keeps new-pair history, drops resolved skew so a recurrence re-alerts", () => {
    const s = pruneResolved({ surfaced: { "new-pair:0.3.283": "t", "skew:2.1.283-vs-2.1.282": "t" } }, []);
    expect(s.surfaced).toEqual({ "new-pair:0.3.283": "t" });
  });
});

describe("registerVersionWatchCron", () => {
  it("registers the static daily pattern and a delayed first run; a tick crash is caught", async () => {
    const cbs: Array<() => void | Promise<void>> = [];
    const scheduled: number[] = [];
    const errors: string[] = [];
    const reg = registerVersionWatchCron({
      ...deps({
        getRuntime: () => {
          throw new Error("boom");
        },
        log: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
      }),
      cronFactory: (pattern, _o, cb) => {
        expect(pattern).toBe(VERSION_WATCH_CRON_PATTERN);
        cbs.push(cb);
        return { stop: vi.fn() };
      },
      schedule: (_fn, ms) => {
        scheduled.push(ms);
        return undefined;
      },
    });
    expect(reg.registered).toBe(true);
    expect(scheduled).toEqual([600_000]);
    await cbs[0]!();
    expect(errors[0]).toContain("boom");
  });

  it("stop() cancels the pending first run as well as the cron", async () => {
    const cronStop = vi.fn();
    const token = { unref: vi.fn() };
    const cancel = vi.fn();
    const reg = registerVersionWatchCron({
      ...deps(),
      cronFactory: () => ({ stop: cronStop }),
      schedule: () => token,
      cancel,
    });
    reg.stop!();
    expect(cancel).toHaveBeenCalledWith(token);
    expect(cronStop).toHaveBeenCalledTimes(1);
  });

  it("with real timers, a stopped watch never fires its first run", async () => {
    vi.useFakeTimers();
    try {
      const posts: string[] = [];
      const reg = registerVersionWatchCron({
        ...deps({ postToAdminClawdy: async (m) => void posts.push(m) }),
        cronFactory: () => ({ stop: () => {} }),
        firstRunDelayMs: 1000,
      });
      reg.stop!();
      await vi.advanceTimersByTimeAsync(5000);
      expect(posts).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a cron construction failure degrades, never throws", () => {
    const reg = registerVersionWatchCron({
      ...deps(),
      cronFactory: () => {
        throw new Error("bad pattern");
      },
      schedule: () => undefined,
    });
    expect(reg).toMatchObject({ registered: false, reason: "pattern-error" });
  });
});

describe("fileStateStore", () => {
  it("round-trips and treats a corrupt file as empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "vw-"));
    const p = join(dir, "state.json");
    const store = fileStateStore(p);
    expect(store.read()).toEqual({ surfaced: {} });
    store.write({ surfaced: { a: "t" } });
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ surfaced: { a: "t" } });
    writeFileSync(p, "{not json");
    expect(store.read()).toEqual({ surfaced: {} });
  });
});
