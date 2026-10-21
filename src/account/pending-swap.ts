/**
 * Phase 999.176 — apply an account swap at daemon BOOT, not live.
 *
 * The operator confirms a swap in Discord; the daemon records an intent
 * file and restarts itself (SIGHUP → exit 129 → systemd restart). The next
 * boot applies the intent before any `claude` process or
 * the warm pool exists. Doing it there removes three failure modes at once:
 *
 *  - a still-running old process refreshing and writing the OLD account
 *    back over the swapped file;
 *  - the proxy's cached first-seen bearer staying on the old account;
 *  - the copy-out missing a refresh that happened during shutdown.
 *
 * The intent is consumed (deleted) BEFORE it is applied, so a crash during
 * apply can never loop, and a stale intent (older than the max age) is
 * dropped rather than springing a surprise swap on a later restart.
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  atomicWrite,
  CredentialSlotError,
  recoverInterruptedSwap,
  SLOT_NAME_RE,
  useSlot,
} from "./credential-slots.js";

export const PENDING_SWAP_MAX_AGE_MS = 15 * 60_000;
/**
 * A boot result older than this is discarded unposted: if the report never
 * went out (Discord down, crash inside the report delay), a LATER unrelated
 * restart must not post an old "switched" message whose Roll back button
 * would point the wrong way.
 */
export const SWAP_RESULT_MAX_AGE_MS = 30 * 60_000;

const SNOWFLAKE_RE = /^\d{5,25}$/;

const intentSchema = z.object({
  target: z.string().regex(SLOT_NAME_RE),
  requestedBy: z.string().regex(SNOWFLAKE_RE),
  channelId: z.string().regex(SNOWFLAKE_RE),
  requestedAt: z.number().int().positive(),
});
export type PendingSwapIntent = z.infer<typeof intentSchema>;

const resultSchema = z.object({
  ok: z.boolean(),
  changed: z.boolean(),
  from: z.string().regex(SLOT_NAME_RE).nullable(),
  to: z.string().regex(SLOT_NAME_RE),
  channelId: z.string().regex(SNOWFLAKE_RE),
  requestedBy: z.string().regex(SNOWFLAKE_RE),
  appliedAt: z.number(),
  error: z.string().max(500).nullable(),
});
export type SwapBootResult = z.infer<typeof resultSchema>;

export type PendingSwapPaths = {
  readonly intentPath: string;
  readonly resultPath: string;
};

export type AccountSwapPaths = PendingSwapPaths & {
  /** Scratch root for isolated preflight/login config dirs (mode 700). */
  readonly workRoot: string;
};

export function accountSwapPathsFor(managerDir: string): AccountSwapPaths {
  const root = join(managerDir, "account-swap");
  return {
    intentPath: join(root, "pending-swap.json"),
    resultPath: join(root, "last-swap-result.json"),
    workRoot: join(root, "work"),
  };
}

export async function writePendingSwap(
  paths: PendingSwapPaths,
  intent: PendingSwapIntent,
): Promise<void> {
  const parsed = intentSchema.parse(intent);
  await mkdir(dirname(paths.intentPath), { recursive: true, mode: 0o700 });
  await atomicWrite(paths.intentPath, JSON.stringify(parsed));
}

export async function clearPendingSwap(paths: PendingSwapPaths): Promise<void> {
  await rm(paths.intentPath, { force: true });
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return undefined;
  }
}

export type BootApplyLog = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

/**
 * Consume + apply a pending swap. Never throws: a failed swap leaves the
 * live credential untouched (useSlot validates before writing) and records
 * the error for the post-boot Discord report.
 */
export async function applyPendingSwapAtBoot(
  paths: PendingSwapPaths,
  configDir: string,
  log: BootApplyLog,
  now: () => number = Date.now,
): Promise<SwapBootResult | null> {
  try {
    const recovered = await recoverInterruptedSwap(configDir);
    if (recovered !== null) {
      log.warn({ component: "account-swap", to: recovered }, "finished an account swap a crash had interrupted");
    }
  } catch (err) {
    log.error(
      { component: "account-swap", error: err instanceof Error ? err.message : String(err) },
      "could not finish an interrupted account swap — live credential left as-is",
    );
  }
  const raw = await readJson(paths.intentPath);
  if (raw === undefined) return null;
  await rm(paths.intentPath, { force: true });

  const parsed = intentSchema.safeParse(raw);
  if (!parsed.success) {
    log.warn({ component: "account-swap" }, "pending account swap intent was malformed — dropped");
    return null;
  }
  const intent = parsed.data;
  if (now() - intent.requestedAt > PENDING_SWAP_MAX_AGE_MS) {
    log.warn(
      { component: "account-swap", target: intent.target, ageMs: now() - intent.requestedAt },
      "pending account swap intent is stale — dropped without swapping",
    );
    return null;
  }

  let result: SwapBootResult;
  try {
    const r = await useSlot(configDir, intent.target);
    result = {
      ok: true,
      changed: r.changed,
      from: r.changed ? r.from : r.slot,
      to: intent.target,
      channelId: intent.channelId,
      requestedBy: intent.requestedBy,
      appliedAt: now(),
      error: null,
    };
    log.info(
      { component: "account-swap", from: result.from, to: result.to, changed: r.changed },
      r.changed ? "fleet account swapped at boot" : "fleet account swap was a no-op (already active)",
    );
  } catch (err) {
    const msg =
      err instanceof CredentialSlotError || err instanceof Error ? err.message : String(err);
    result = {
      ok: false,
      changed: false,
      from: null,
      to: intent.target,
      channelId: intent.channelId,
      requestedBy: intent.requestedBy,
      appliedAt: now(),
      error: msg.slice(0, 500),
    };
    log.error({ component: "account-swap", target: intent.target, error: msg }, "fleet account swap FAILED at boot — live credential unchanged");
  }
  try {
    await mkdir(dirname(paths.resultPath), { recursive: true, mode: 0o700 });
    await atomicWrite(paths.resultPath, JSON.stringify(result));
  } catch (err) {
    log.warn(
      { component: "account-swap", error: err instanceof Error ? err.message : String(err) },
      "could not record account swap result",
    );
  }
  return result;
}

/** Read + delete the boot result so the report posts exactly once. */
export async function consumeSwapBootResult(
  paths: PendingSwapPaths,
  now: () => number = Date.now,
): Promise<SwapBootResult | null> {
  const raw = await readJson(paths.resultPath);
  if (raw === undefined) return null;
  await rm(paths.resultPath, { force: true });
  const parsed = resultSchema.safeParse(raw);
  if (!parsed.success) return null;
  return now() - parsed.data.appliedAt > SWAP_RESULT_MAX_AGE_MS ? null : parsed.data;
}
