import { describe, it, expect } from "vitest";
import {
  isBrowserInstance,
  countBrowserInstances,
  chromeOwner,
  chromeOwnerBreakdown,
  type ChromeProcLike,
} from "../chrome-instances.js";

/**
 * INC-2026-08-09 — MemoryGuard paged `chrome count 17 over budget 12 (1598MB)`
 * while every kernel pressure metric read zero. 22 processes were 2 browsers.
 * These tests pin the counting rule that makes that alert impossible.
 */

const SHOPPING_PROFILE = "/home/clawcode/.clawcode/agents/shopping/browser-profile";
const POOLED_PROFILE = "/tmp/playwright_chromiumdev_profile-abc123";

/** The live fleet population: 2 browsers + 2 crash handlers + 13 helpers. */
function liveFixture(): ChromeProcLike[] {
  const procs: ChromeProcLike[] = [
    // Browser mains — no --type=
    { comm: "chrome", args: `/opt/google/chrome/chrome --user-data-dir=${SHOPPING_PROFILE} --no-sandbox` },
    { comm: "chrome-headless-shell", args: `/ms-playwright/chrome-headless-shell --user-data-dir=${POOLED_PROFILE} --no-startup-window` },
    // Crash handlers — comm truncated at 15 chars by /proc, and NO --type=.
    // A naive "no --type= means browser" rule counts these and reports 4.
    { comm: "chrome_crashpad", args: `/opt/google/chrome/chrome_crashpad_handler --monitor-self --database=${SHOPPING_PROFILE}/Crashpad` },
    { comm: "chrome_crashpad", args: `/ms-playwright/chrome_crashpad_handler --monitor-self` },
  ];
  const roles = [
    "zygote", "zygote", "gpu-process", "utility", "utility", "utility",
    "renderer", "renderer", "renderer", "renderer", "broker", "network.mojom.NetworkService", "storage.mojom.StorageService",
  ];
  for (const role of roles) {
    procs.push({ comm: "chrome", args: `/opt/google/chrome/chrome --type=${role} --user-data-dir=${SHOPPING_PROFILE}` });
  }
  return procs;
}

describe("isBrowserInstance", () => {
  it("counts a browser main (no --type=)", () => {
    expect(isBrowserInstance({ comm: "chrome", args: "/opt/google/chrome/chrome --no-sandbox" })).toBe(true);
  });

  it("rejects every helper role (--type= present)", () => {
    for (const role of ["renderer", "gpu-process", "zygote", "utility", "broker"]) {
      expect(isBrowserInstance({ comm: "chrome", args: `/opt/google/chrome/chrome --type=${role}` })).toBe(false);
    }
  });

  it("rejects the crash handler — THE TRAP (it has no --type=)", () => {
    // /proc comm truncates at 15 chars, so the full name never arrives.
    expect(isBrowserInstance({ comm: "chrome_crashpad", args: "/opt/google/chrome/chrome_crashpad_handler --monitor-self" })).toBe(false);
  });

  it("ignores non-chrome processes entirely", () => {
    expect(isBrowserInstance({ comm: "node", args: "node server.js" })).toBe(false);
  });

  it("handles chromium naming", () => {
    expect(isBrowserInstance({ comm: "chromium", args: "/usr/bin/chromium --no-sandbox" })).toBe(true);
    expect(isBrowserInstance({ comm: "chromium", args: "/usr/bin/chromium --type=renderer" })).toBe(false);
  });

  it("does not mistake a flag that merely contains 'type=' for the helper marker", () => {
    // e.g. a URL or a profile path containing the substring. Only a real
    // `--type=` token (start-of-string or space-prefixed) counts.
    expect(isBrowserInstance({ comm: "chrome", args: "/opt/google/chrome/chrome --foo=bar?type=renderer" })).toBe(true);
  });
});

describe("countBrowserInstances — the reported incident", () => {
  it("collapses the live 17-proc fixture to 2 instances", () => {
    const procs = liveFixture();
    expect(procs.length).toBe(17);
    // This is the whole fix: 17 procs, 2 browsers, budget 3 ⇒ NO alert.
    expect(countBrowserInstances(procs)).toBe(2);
  });

  it("would have counted 4 without the crashpad exclusion (regression guard)", () => {
    const naive = liveFixture().filter((p) => !/(^|\s)--type=/.test(p.args)).length;
    expect(naive).toBe(4);
    expect(countBrowserInstances(liveFixture())).toBe(2);
  });

  it("survives a ~900-char renderer cmdline (the 400→1024 slice widen)", () => {
    // If --type= ever falls outside the captured cmdline slice, every renderer
    // reclassifies as a browser and MemoryGuard pages hard — the exact failure
    // this work exists to remove. The marker sits early, but the arg list is long.
    const long = `/opt/google/chrome/chrome --type=renderer --user-data-dir=${SHOPPING_PROFILE} ` +
      Array.from({ length: 60 }, (_, i) => `--feature-flag-number-${i}=some-reasonably-long-value`).join(" ");
    expect(long.length).toBeGreaterThan(900);
    expect(isBrowserInstance({ comm: "chrome", args: long.slice(0, 1024) })).toBe(false);
  });
});

describe("chromeOwner / chromeOwnerBreakdown", () => {
  it("names the owning agent from an agent profile dir", () => {
    expect(chromeOwner({ comm: "chrome", args: `chrome --user-data-dir=${SHOPPING_PROFILE}` })).toBe("shopping");
  });

  it("labels the pooled playwright profile", () => {
    expect(chromeOwner({ comm: "chrome", args: `chrome --user-data-dir=${POOLED_PROFILE}` })).toBe("pooled");
  });

  it("labels the reaper-scoped agent-browser profile", () => {
    expect(chromeOwner({ comm: "chrome", args: "chrome --user-data-dir=/tmp/agent-browser-chrome-xyz" })).toBe("agent-browser");
  });

  it("degrades to unknown rather than guessing", () => {
    expect(chromeOwner({ comm: "chrome", args: "chrome --no-sandbox" })).toBe("unknown");
  });

  it("builds the Who: line from browser instances only, not helpers", () => {
    const breakdown = chromeOwnerBreakdown(liveFixture());
    // 13 helpers all carry the shopping profile but must NOT inflate the count.
    expect(breakdown).toEqual([
      { owner: "pooled", instances: 1 },
      { owner: "shopping", instances: 1 },
    ]);
  });
});
