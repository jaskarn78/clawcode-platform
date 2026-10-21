/**
 * Phase 999.176 — fleet Max-account credential slots (TypeScript port).
 *
 * Byte-compatible with the proven shell tool on `feat/max-account-switch`
 * (`scripts/lib/clawcode-credential-swap.sh`), so the daemon and the ssh
 * break-glass script can operate on the same directory interchangeably:
 *
 *   <configDir>/.credentials.json         the LIVE credential every `claude`
 *                                         process (and haiku-direct) reads
 *   <configDir>/.credentials.<slot>.json  a saved credential per account
 *   <configDir>/.clawcode-account         marker: the slot name that is live
 *
 * Swap = copy-out-then-copy-in. The `claude` binary refreshes the live
 * access token IN PLACE and rotates the refresh token on every refresh, so
 * the live file is always the freshest copy of the current account. Copying
 * it back to its own slot before swapping is what keeps rollback alive —
 * a slot left alone goes stale within a day ([[project_fleet_account_swap]]).
 *
 * Every write is tmp-in-same-dir + rename, so a crash never leaves a torn
 * `.credentials.json` that would lock the whole fleet out. Token values are
 * never returned or logged: summaries carry only a sha256 prefix of the
 * refresh token (an eyeball identity) plus expiry and tier metadata.
 */

import { createHash, randomBytes } from "node:crypto";
import { chmod, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ACTIVE_BASENAME = ".credentials.json";
export const MARKER_BASENAME = ".clawcode-account";
/**
 * Written after the copy-out and removed after the marker update. If a crash
 * leaves it behind, {@link recoverInterruptedSwap} finishes the swap: the
 * copy-out already happened, so re-installing the target is always safe.
 * Without it, a crash between "install target" and "update marker" would
 * make the NEXT swap copy the target's credential over the old account's
 * slot, destroying the rollback copy.
 */
export const JOURNAL_BASENAME = ".clawcode-account.swapping";

/** Slot names become path components — keep them boring (mirrors the shell regex). */
export const SLOT_NAME_RE = /^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/;

export class CredentialSlotError extends Error {
  constructor(
    readonly code:
      | "invalid-slot"
      | "no-active"
      | "unlabeled"
      | "slot-missing"
      | "unreadable",
    message: string,
  ) {
    super(message);
    this.name = "CredentialSlotError";
  }
}

export type CredentialSummary = {
  readonly present: boolean;
  readonly readable: boolean;
  readonly subscriptionType: string | null;
  readonly rateLimitTier: string | null;
  /** sha256(refreshToken)[0:12] — identity eyeball, never the token. */
  readonly refreshSha: string | null;
  /** ms since epoch; null when absent. */
  readonly expiresAt: number | null;
};

export type SlotStatus = CredentialSummary & {
  readonly name: string;
  /** True when this slot's refresh token is the one currently live. */
  readonly matchesLive: boolean;
};

export type AccountStatus = {
  readonly configDir: string;
  /** Marker contents; null when the live credential is unlabeled. */
  readonly activeSlot: string | null;
  readonly live: CredentialSummary;
  readonly slots: readonly SlotStatus[];
};

export function assertSlotName(name: string): void {
  if (!SLOT_NAME_RE.test(name)) {
    throw new CredentialSlotError("invalid-slot", `invalid slot name '${name}'`);
  }
}

export function activePath(configDir: string): string {
  return join(configDir, ACTIVE_BASENAME);
}

export function markerPath(configDir: string): string {
  return join(configDir, MARKER_BASENAME);
}

export function journalPath(configDir: string): string {
  return join(configDir, JOURNAL_BASENAME);
}

export function slotPath(configDir: string, name: string): string {
  assertSlotName(name);
  return join(configDir, `.credentials.${name}.json`);
}

const ABSENT: CredentialSummary = Object.freeze({
  present: false,
  readable: false,
  subscriptionType: null,
  rateLimitTier: null,
  refreshSha: null,
  expiresAt: null,
});

/** Redacted summary of a credential JSON document (already parsed). */
export function summarizeCredentialJson(raw: string): CredentialSummary {
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>;
    const oauth = (doc["claudeAiOauth"] ?? {}) as Record<string, unknown>;
    const rt = oauth["refreshToken"];
    const exp = oauth["expiresAt"];
    const str = (v: unknown): string | null =>
      typeof v === "string" && v.length > 0 ? v : null;
    return {
      present: true,
      readable: true,
      subscriptionType: str(oauth["subscriptionType"]),
      rateLimitTier: str(oauth["rateLimitTier"]),
      refreshSha:
        typeof rt === "string" && rt.length > 0
          ? createHash("sha256").update(rt).digest("hex").slice(0, 12)
          : null,
      expiresAt: typeof exp === "number" ? exp : null,
    };
  } catch {
    return { ...ABSENT, present: true };
  }
}

export async function summarizeCredentialFile(
  path: string,
): Promise<CredentialSummary> {
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return ABSENT;
  }
  return summarizeCredentialJson(raw);
}

/** True when the document carries a non-empty refresh token (the only part that matters). */
export function hasRefreshToken(raw: string): boolean {
  return summarizeCredentialJson(raw).refreshSha !== null;
}

async function readMarker(configDir: string): Promise<string | null> {
  try {
    const v = (await readFile(markerPath(configDir), "utf-8")).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Write `contents` to `dest` atomically (same-dir tmp + rename), mode 600. */
export async function atomicWrite(dest: string, contents: string): Promise<void> {
  const tmp = `${dest}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, contents, { encoding: "utf-8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, dest);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

async function atomicCopy(src: string, dest: string): Promise<void> {
  const contents = await readFile(src, "utf-8");
  await atomicWrite(dest, contents);
}

export async function readAccountStatus(
  configDir: string,
  slotNames: readonly string[],
): Promise<AccountStatus> {
  const live = await summarizeCredentialFile(activePath(configDir));
  const slots: SlotStatus[] = [];
  for (const name of slotNames) {
    const s = await summarizeCredentialFile(slotPath(configDir, name));
    slots.push({
      ...s,
      name,
      matchesLive: s.refreshSha !== null && s.refreshSha === live.refreshSha,
    });
  }
  return {
    configDir,
    activeSlot: await readMarker(configDir),
    live,
    slots,
  };
}

/**
 * Copy the live credential into its own (marked) slot. Called before every
 * swap and exposed so rollback can be re-armed on demand. Returns the slot
 * name written.
 */
export async function snapshotLive(configDir: string): Promise<string> {
  const current = await readMarker(configDir);
  if (current === null) {
    throw new CredentialSlotError(
      "unlabeled",
      "the live credential is unlabeled — refusing to snapshot. Label it with the ssh tool (`snapshot <name>`) first.",
    );
  }
  assertSlotName(current);
  await atomicCopy(activePath(configDir), slotPath(configDir, current));
  return current;
}

export type UseSlotResult =
  | { readonly changed: false; readonly slot: string }
  | { readonly changed: true; readonly from: string; readonly to: string };

/**
 * Switch the live credential to `target`. Copy-out (capture the live
 * account's latest refresh), copy-in (atomic), then marker. Mirrors the
 * shell `--use` mode exactly, including its refusal cases.
 *
 * MUST run while no `claude` process holds the old credential — otherwise a
 * late refresh from an old process can write the old account back over the
 * swap. The daemon calls this at boot, before anything is spawned.
 */
export async function useSlot(
  configDir: string,
  target: string,
): Promise<UseSlotResult> {
  assertSlotName(target);
  const active = activePath(configDir);
  let liveRaw: string;
  try {
    liveRaw = await readFile(active, "utf-8");
  } catch {
    throw new CredentialSlotError("no-active", `no live credential at ${active}`);
  }
  const current = await readMarker(configDir);
  if (current === null) {
    throw new CredentialSlotError(
      "unlabeled",
      "the live credential is unlabeled — refusing to switch (the copy-out would have no slot to land in).",
    );
  }
  assertSlotName(current);
  if (current === target) return { changed: false, slot: target };

  let targetRaw: string;
  try {
    targetRaw = await readFile(slotPath(configDir, target), "utf-8");
  } catch {
    throw new CredentialSlotError("slot-missing", `slot '${target}' is not seeded`);
  }
  if (!hasRefreshToken(targetRaw)) {
    throw new CredentialSlotError(
      "unreadable",
      `slot '${target}' has no refresh token — refusing to install it`,
    );
  }

  await atomicWrite(slotPath(configDir, current), liveRaw);
  await atomicWrite(journalPath(configDir), JSON.stringify({ from: current, to: target }));
  await atomicWrite(active, targetRaw);
  await atomicWrite(markerPath(configDir), `${target}\n`);
  await rm(journalPath(configDir), { force: true });
  return { changed: true, from: current, to: target };
}

/**
 * Finish a swap a crash interrupted (journal present). Returns the slot it
 * completed, or null when there was nothing to recover. Call at boot before
 * anything reads the live credential.
 */
export async function recoverInterruptedSwap(configDir: string): Promise<string | null> {
  let journal: { from?: unknown; to?: unknown };
  try {
    journal = JSON.parse(await readFile(journalPath(configDir), "utf-8")) as typeof journal;
  } catch {
    return null;
  }
  const to = journal.to;
  if (typeof to !== "string" || !SLOT_NAME_RE.test(to)) {
    await rm(journalPath(configDir), { force: true });
    return null;
  }
  const targetRaw = await readFile(slotPath(configDir, to), "utf-8");
  if (!hasRefreshToken(targetRaw)) {
    throw new CredentialSlotError("unreadable", `cannot finish interrupted swap: slot '${to}' has no refresh token`);
  }
  await atomicWrite(activePath(configDir), targetRaw);
  await atomicWrite(markerPath(configDir), `${to}\n`);
  await rm(journalPath(configDir), { force: true });
  return to;
}

/** Install fresh credential JSON into a slot (after a login or a preflight refresh). */
export async function writeSlot(
  configDir: string,
  name: string,
  raw: string,
): Promise<void> {
  if (!hasRefreshToken(raw)) {
    throw new CredentialSlotError(
      "unreadable",
      `refusing to write slot '${name}': credential has no refresh token`,
    );
  }
  await atomicWrite(slotPath(configDir, name), raw);
}
