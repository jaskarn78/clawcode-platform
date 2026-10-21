/**
 * Phase 999.117 WS-6 — orphaned-inbox detection.
 *
 * WHY THIS EXISTS
 *
 * On 2026-09-03 an audit of `clawdy` found **185 messages** sitting in
 * `~/.clawcode/agents/general/inbox`, addressed to an agent named `general`
 * that does not exist in the config. They accumulated from 2026-07-14 to
 * 2026-08-06 — three weeks — and were never delivered. No alert fired, no
 * metric moved, nothing surfaced in any channel. They were all
 * `[imsg-monitor]` alerts, i.e. real inbound iMessages that someone was
 * expecting an agent to act on.
 *
 * The daemon's own writers all validate the target, so these came from
 * something writing `writeMessage` directly (a cron/trigger outside the IPC
 * path). That is exactly why detection belongs on the CONSUMER side: a
 * producer-side check can only ever cover the producers it knows about. Any
 * inbox directory that no configured agent owns is, by definition, a place
 * messages go to die — regardless of who wrote them.
 *
 * This module is pure discovery. It never deletes; the CLI decides what to do
 * with what it finds.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export type OrphanInbox = Readonly<{
  /** Absolute path of the orphaned inbox directory. */
  path: string;
  /** Directory name — usually the agent name it was addressed to. */
  label: string;
  /** Undelivered message count. */
  pending: number;
  /** Oldest undelivered message timestamp, ms. Undefined when none parse. */
  oldestAt?: number;
  /** Newest undelivered message timestamp, ms. */
  newestAt?: number;
  /** Distinct senders seen, for attributing the leak to a producer. */
  senders: readonly string[];
}>;

export type OrphanScanDeps = Readonly<{
  /** Root that holds one directory per agent (`defaults.basePath`). */
  basePath: string;
  /**
   * Inbox directories that ARE owned by a live agent. Resolved memoryPath +
   * "/inbox" for every configured agent — pass the RESOLVED paths, not the
   * raw YAML: `memoryPath` defaults to the workspace, which itself defaults
   * to basePath/<name>, and getting that wrong is how the audit initially
   * mislabelled three live inboxes as empty.
   */
  ownedInboxDirs: readonly string[];
}>;

/** Normalise for comparison — trailing slashes differ between call sites. */
function canonical(p: string): string {
  return p.replace(/\/+$/, "");
}

/**
 * Find inbox directories under `basePath` that no configured agent owns.
 *
 * Returns only directories that actually hold undelivered messages: an empty
 * orphaned directory is harmless residue, and reporting it would bury the
 * signal that matters.
 */
export async function scanOrphanInboxes(
  deps: OrphanScanDeps,
): Promise<readonly OrphanInbox[]> {
  const owned = new Set(deps.ownedInboxDirs.map(canonical));
  let entries: string[];
  try {
    entries = await readdir(deps.basePath);
  } catch {
    return [];
  }

  const found: OrphanInbox[] = [];
  for (const entry of entries) {
    // Two shapes exist in the wild: <base>/<agent>/inbox and
    // <base>/<agent>/memory/inbox, because memoryPath defaults to the
    // workspace but can be set to a nested directory. Check both.
    for (const candidate of [
      join(deps.basePath, entry, "inbox"),
      join(deps.basePath, entry, "memory", "inbox"),
    ]) {
      if (owned.has(canonical(candidate))) continue;
      const orphan = await inspectInbox(candidate, entry);
      if (orphan && orphan.pending > 0) found.push(orphan);
    }
  }
  return found.sort((a, b) => b.pending - a.pending);
}

async function inspectInbox(
  path: string,
  label: string,
): Promise<OrphanInbox | undefined> {
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return undefined;
  } catch {
    return undefined;
  }

  let files: string[];
  try {
    files = (await readdir(path)).filter((f) => f.endsWith(".json"));
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;

  const senders = new Set<string>();
  let oldestAt: number | undefined;
  let newestAt: number | undefined;

  for (const file of files) {
    try {
      const raw = await readFile(join(path, file), "utf-8");
      const msg = JSON.parse(raw) as { from?: string; timestamp?: number };
      if (typeof msg.from === "string") senders.add(msg.from);
      if (typeof msg.timestamp === "number") {
        if (oldestAt === undefined || msg.timestamp < oldestAt) oldestAt = msg.timestamp;
        if (newestAt === undefined || msg.timestamp > newestAt) newestAt = msg.timestamp;
      }
    } catch {
      // Unreadable file still counts as pending — it is undelivered either way.
    }
  }

  return {
    path,
    label,
    pending: files.length,
    ...(oldestAt !== undefined ? { oldestAt } : {}),
    ...(newestAt !== undefined ? { newestAt } : {}),
    senders: [...senders].sort(),
  };
}
