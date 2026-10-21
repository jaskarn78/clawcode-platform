import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activePath, markerPath, slotPath } from "../credential-slots.js";
import {
  PENDING_SWAP_MAX_AGE_MS,
  SWAP_RESULT_MAX_AGE_MS,
  accountSwapPathsFor,
  applyPendingSwapAtBoot,
  consumeSwapBootResult,
  writePendingSwap,
} from "../pending-swap.js";
import { AccountService } from "../account-service.js";
import { handleAccountIpc, isAccountIpcMethod } from "../account-ipc.js";
import { buildMacLoginInstruction, classifyMacReply } from "../mac-login-instruction.js";

const cred = (rt: string): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: rt, expiresAt: Date.now() + 3.6e6 } });
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const CHANNEL = "000000000000000105";

let root: string;
let configDir: string;
let paths: ReturnType<typeof accountSwapPathsFor>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "swap-life-"));
  configDir = join(root, "claude");
  await mkdir(configDir);
  paths = accountSwapPathsFor(join(root, "manager"));
  await writeFile(activePath(configDir), cred("main-live"));
  await writeFile(markerPath(configDir), "main\n");
  await writeFile(slotPath(configDir, "admin"), cred("admin-rt"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("interrupted swap recovery", () => {
  it("finishes a swap that crashed after install but before the marker, without clobbering the old slot", async () => {
    // Simulate the crash: copy-out done, journal written, target installed, marker NOT updated.
    await writeFile(slotPath(configDir, "main"), cred("main-live"));
    await writeFile(join(configDir, ".clawcode-account.swapping"), JSON.stringify({ from: "main", to: "admin" }));
    await writeFile(activePath(configDir), cred("admin-rt"));

    await applyPendingSwapAtBoot(paths, configDir, log);

    expect(await readFile(markerPath(configDir), "utf-8")).toBe("admin\n");
    expect(JSON.parse(await readFile(slotPath(configDir, "main"), "utf-8")).claudeAiOauth.refreshToken).toBe("main-live");
    await expect(stat(join(configDir, ".clawcode-account.swapping"))).rejects.toThrow();
  });

  it("a completed swap leaves no journal", async () => {
    await writePendingSwap(paths, { target: "admin", requestedBy: "42424242", channelId: CHANNEL, requestedAt: Date.now() });
    await applyPendingSwapAtBoot(paths, configDir, log);
    await expect(stat(join(configDir, ".clawcode-account.swapping"))).rejects.toThrow();
  });
});

describe("applyPendingSwapAtBoot", () => {
  it("does nothing without an intent", async () => {
    expect(await applyPendingSwapAtBoot(paths, configDir, log)).toBeNull();
  });

  it("consumes the intent, swaps, and records a result for the boot report", async () => {
    await writePendingSwap(paths, { target: "admin", requestedBy: "42424242", channelId: CHANNEL, requestedAt: Date.now() });
    expect((await stat(paths.intentPath)).mode & 0o777).toBe(0o600);

    const r = await applyPendingSwapAtBoot(paths, configDir, log);
    expect(r).toMatchObject({ ok: true, changed: true, from: "main", to: "admin" });
    await expect(stat(paths.intentPath)).rejects.toThrow();
    expect(JSON.parse(await readFile(activePath(configDir), "utf-8")).claudeAiOauth.refreshToken).toBe("admin-rt");
    expect(JSON.parse(await readFile(slotPath(configDir, "main"), "utf-8")).claudeAiOauth.refreshToken).toBe("main-live");

    expect(await consumeSwapBootResult(paths)).toMatchObject({ ok: true, to: "admin", channelId: CHANNEL });
    expect(await consumeSwapBootResult(paths)).toBeNull();
  });

  it("never posts a stale boot result from an earlier restart", async () => {
    await writePendingSwap(paths, { target: "admin", requestedBy: "42424242", channelId: CHANNEL, requestedAt: Date.now() });
    await applyPendingSwapAtBoot(paths, configDir, log);
    const later = () => Date.now() + SWAP_RESULT_MAX_AGE_MS + 1;
    expect(await consumeSwapBootResult(paths, later)).toBeNull();
    await expect(stat(paths.resultPath)).rejects.toThrow();
  });

  it("drops a stale intent without swapping", async () => {
    await writePendingSwap(paths, {
      target: "admin",
      requestedBy: "42424242",
      channelId: CHANNEL,
      requestedAt: Date.now() - PENDING_SWAP_MAX_AGE_MS - 1,
    });
    expect(await applyPendingSwapAtBoot(paths, configDir, log)).toBeNull();
    expect(JSON.parse(await readFile(activePath(configDir), "utf-8")).claudeAiOauth.refreshToken).toBe("main-live");
    await expect(stat(paths.intentPath)).rejects.toThrow();
  });

  it("records a failure and leaves the live credential alone", async () => {
    await writePendingSwap(paths, { target: "ghost", requestedBy: "42424242", channelId: CHANNEL, requestedAt: Date.now() });
    const r = await applyPendingSwapAtBoot(paths, configDir, log);
    expect(r).toMatchObject({ ok: false, to: "ghost" });
    expect(JSON.parse(await readFile(activePath(configDir), "utf-8")).claudeAiOauth.refreshToken).toBe("main-live");
  });

  it("drops a malformed intent", async () => {
    await mkdir(join(root, "manager", "account-swap"), { recursive: true });
    await writeFile(paths.intentPath, JSON.stringify({ target: "../etc", requestedBy: "x", channelId: "c", requestedAt: 1 }));
    expect(await applyPendingSwapAtBoot(paths, configDir, log)).toBeNull();
  });
});

describe("AccountService guards", () => {
  const make = (restart = vi.fn()) =>
    new AccountService({
      oauth: { claudeBin: "/nonexistent/claude", configDir, workRoot: paths.workRoot },
      paths,
      getSlots: () => [
        { name: "main", email: "main@example.com" },
        { name: "admin", email: "admin@example.com" },
      ],
      requestRestart: restart,
    });

  it("refuses unconfigured and already-active targets", async () => {
    const svc = make();
    await expect(svc.preflight("other")).rejects.toThrow(/not a configured/);
    await expect(svc.preflight("main")).rejects.toThrow(/already on/);
  });

  it("scheduleSwap writes the intent and requests a restart", async () => {
    const restart = vi.fn();
    await make(restart).scheduleSwap({ target: "admin", requestedBy: "42424242", channelId: CHANNEL });
    expect(restart).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(paths.intentPath, "utf-8"))).toMatchObject({ target: "admin" });
  });

  it("submitCode with an unknown session is refused", async () => {
    expect(await make().submitCode("nope", "code")).toMatchObject({ accepted: false });
  });
});

describe("account IPC", () => {
  const svc = (): AccountService =>
    new AccountService({
      oauth: { claudeBin: "/nonexistent/claude", configDir, workRoot: paths.workRoot },
      paths,
      getSlots: () => [{ name: "admin", email: "admin@example.com" }],
      requestRestart: vi.fn(),
    });

  it("exposes only status and submit", () => {
    expect(isAccountIpcMethod("account-status")).toBe(true);
    expect(isAccountIpcMethod("account-login-submit")).toBe(true);
    expect(isAccountIpcMethod("account-swap")).toBe(false);
  });

  it("status reports no pending login when none was started", async () => {
    expect(await handleAccountIpc(svc(), "account-status", {})).toMatchObject({ pendingLogin: null });
  });

  it("status carries no token values", async () => {
    const r = await handleAccountIpc(svc(), "account-status", {});
    const text = JSON.stringify(r);
    expect(text).not.toContain("admin-rt");
    expect(text).not.toContain("main-live");
    expect(text).toContain("admin@example.com");
  });

  it("submit validates params", async () => {
    expect(await handleAccountIpc(svc(), "account-login-submit", { sessionId: "../x", code: "c" })).toMatchObject({
      accepted: false,
    });
  });
});

describe("Mac login instruction", () => {
  it("carries no link or session id; reads the pending login from the daemon; code on stdin", () => {
    const text = buildMacLoginInstruction({ email: "admin@example.com", opItem: "Google admin" });
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).toContain("clawcode account status");
    expect(text).toContain("pendingLogin");
    expect(text).toContain("clawcode account submit-code <<'CODE'");
    expect(text).toContain("`accounts.google.com`");
    expect(text).toContain("admin@example.com");
    expect(text).toContain('isolatedContext: "clawcode-account-login"');
    expect(text).toContain("`Google admin`");
  });

  it("classifies replies", () => {
    expect(classifyMacReply("MAC_DONE")).toEqual({ kind: "done" });
    expect(classifyMacReply("MAC_UNAVAILABLE: screen locked")).toEqual({ kind: "unavailable", reason: "screen locked" });
    expect(classifyMacReply("")).toMatchObject({ kind: "unavailable" });
  });
});
