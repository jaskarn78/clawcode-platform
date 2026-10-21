/**
 * Phase 999.117 WS-6 — `clawcode a2a` operator surface.
 *
 * Agent-to-agent traffic had no operator surface at all: no way to see which
 * pairs were talking, whether a loop guard had tripped, or — most importantly
 * — whether messages were landing somewhere nothing reads. A 2026-09-03 audit
 * found 185 messages that had sat undelivered for three weeks in an inbox
 * belonging to an agent that does not exist, with nothing anywhere reporting
 * it.
 *
 *   clawcode a2a status    governor mode, thresholds, open circuit breakers
 *   clawcode a2a orphans   inbox directories no configured agent owns
 */

import type { Command } from "commander";
import { readdir, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sendIpcRequest } from "../../ipc/client.js";
import { SOCKET_PATH } from "../../manager/daemon.js";
import { ManagerNotRunningError } from "../../shared/errors.js";
import { cliLog, cliError } from "../output.js";
import { scanOrphanInboxes, type OrphanInbox } from "../../collaboration/orphan-inbox.js";
import { loadConfig, resolveAllAgents } from "../../config/loader.js";
import { expandHome } from "../../config/defaults.js";

type A2aStatusResponse = Readonly<{
  governor: {
    mode: string;
    maxHops: number;
    maxConsecutiveAutoReplies: number;
    pairWindowMax: number;
    pairWindowMs: number;
    conversationCap: number;
    conversationIdleMs: number;
  };
  trackedConversations: number;
  openBreakers: readonly { from: string; to: string; reopensAt: number }[];
  dedupeTracked: number;
}>;

function fmtAge(ts: number | undefined): string {
  if (ts === undefined) return "-";
  const days = (Date.now() - ts) / 86_400_000;
  if (days >= 1) return `${days.toFixed(0)}d ago`;
  const hours = (Date.now() - ts) / 3_600_000;
  if (hours >= 1) return `${hours.toFixed(0)}h ago`;
  return `${Math.max(1, Math.round((Date.now() - ts) / 60_000))}m ago`;
}

export function formatOrphanReport(orphans: readonly OrphanInbox[]): string {
  if (orphans.length === 0) {
    return "No orphaned inboxes — every inbox with pending messages belongs to a configured agent.";
  }

  const total = orphans.reduce((n, o) => n + o.pending, 0);
  const lines: string[] = [
    `${orphans.length} orphaned inbox${orphans.length === 1 ? "" : "es"} holding ${total} undelivered message${total === 1 ? "" : "s"}.`,
    "",
    "These directories belong to no configured agent, so nothing watches them.",
    "Messages written here are never delivered and never reported.",
    "",
  ];

  for (const o of orphans) {
    lines.push(`  ${o.label}  (${o.pending} pending)`);
    lines.push(`    path    ${o.path}`);
    lines.push(`    oldest  ${fmtAge(o.oldestAt)}`);
    lines.push(`    newest  ${fmtAge(o.newestAt)}`);
    if (o.senders.length > 0) {
      lines.push(`    from    ${o.senders.join(", ")}`);
    }
    lines.push("");
  }

  lines.push("Archive them with:  clawcode a2a orphans --archive");
  lines.push("(moves each file to <inbox>/orphaned/ — nothing is deleted)");
  return lines.join("\n");
}

/** Move every pending message into an `orphaned/` subdirectory. Never deletes. */
async function archiveOrphan(orphan: OrphanInbox): Promise<number> {
  const dest = join(orphan.path, "orphaned");
  await mkdir(dest, { recursive: true });
  const files = (await readdir(orphan.path)).filter((f) => f.endsWith(".json"));
  let moved = 0;
  for (const file of files) {
    try {
      await rename(join(orphan.path, file), join(dest, file));
      moved++;
    } catch {
      // Leave anything that will not move; a partial archive is still progress.
    }
  }
  return moved;
}

export function registerA2aCommand(program: Command): void {
  const a2a = program
    .command("a2a")
    .description("Inspect agent-to-agent messaging (loop guards, orphaned inboxes)");

  a2a
    .command("status")
    .description("Show loop-governor state and open circuit breakers")
    .action(async () => {
      try {
        const res = (await sendIpcRequest(SOCKET_PATH, "a2a-status", {})) as A2aStatusResponse;
        const g = res.governor;
        cliLog(`loop governor: ${g.mode}`);
        cliLog(`  maxHops                    ${g.maxHops}`);
        cliLog(`  maxConsecutiveAutoReplies  ${g.maxConsecutiveAutoReplies}`);
        cliLog(`  pair rate                  ${g.pairWindowMax} / ${Math.round(g.pairWindowMs / 60_000)}min`);
        cliLog(`  conversationCap            ${g.conversationCap}`);
        cliLog(`  conversationIdle           ${Math.round(g.conversationIdleMs / 60_000)}min`);
        cliLog("");
        cliLog(`tracked conversations        ${res.trackedConversations}`);
        cliLog(`dedupe entries               ${res.dedupeTracked}`);
        cliLog("");
        if (res.openBreakers.length === 0) {
          cliLog("no open circuit breakers");
        } else {
          cliLog(`${res.openBreakers.length} OPEN circuit breaker(s):`);
          for (const b of res.openBreakers) {
            cliLog(`  ${b.from} -> ${b.to}  reopens ${new Date(b.reopensAt).toLocaleTimeString()}`);
          }
        }
      } catch (err) {
        if (err instanceof ManagerNotRunningError) {
          cliError("Manager is not running.");
          process.exitCode = 1;
          return;
        }
        cliError(`Failed to read a2a status: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });

  a2a
    .command("orphans")
    .description("Find inbox directories that no configured agent owns")
    .option("--archive", "move pending messages into <inbox>/orphaned/ (never deletes)")
    // Mirrors the root command's default so `clawcode a2a orphans` works
    // with no flag, the same way every other subcommand does.
    .option("-c, --config <path>", "Path to config file", "clawcode.yaml")
    .action(async (opts: { archive?: boolean; config: string }) => {
      try {
        const config = await loadConfig(opts.config);
        // Owned = the RESOLVED memoryPath of every configured agent, via
        // resolveAllAgents. NOT the raw YAML: `memoryPath` is usually absent
        // and defaults to the workspace, which itself defaults to
        // basePath/<name>. Reading the raw block would mislabel live inboxes
        // as orphans — and this command offers to archive what it finds, so
        // getting that wrong would move real undelivered mail out of the way.
        // (The same mistake mislabelled three live inboxes as empty during
        // the audit that motivated this command.)
        const resolvedAgents = resolveAllAgents(config);
        const ownedInboxDirs = resolvedAgents.map((a) => join(a.memoryPath, "inbox"));
        // `defaults.basePath` is stored RAW (`~/.clawcode/agents`) — the
        // loader expands it per-agent, not in place. Expanding here matters
        // because the fail-closed guard below turns an unexpanded path into a
        // hard error rather than a false "no orphaned inboxes"; without the
        // expansion the command is simply unusable.
        const basePath = expandHome(config.defaults.basePath);

        // `basePath` is `~/.clawcode/agents`, and expandHome resolves against
        // the INVOKING user's HOME. On the box the daemon runs as `clawcode`,
        // so `sudo clawcode a2a orphans` expands to /root/.clawcode/agents —
        // an empty directory — and the command prints a clean "no orphaned
        // inboxes". That is the single most dangerous output a command whose
        // whole purpose is finding messages nothing reports can produce, and
        // it is not hypothetical: the audit script that found the 185-message
        // black hole hit exactly this and had to be re-run with an explicit
        // HOME. So always state which root was scanned, and refuse to report
        // "nothing found" for a root that does not exist.
        cliLog(`scanning ${basePath}`);
        if (!existsSync(basePath)) {
          cliError(
            `That directory does not exist, so this scan found nothing — ` +
              `which is NOT the same as "no orphaned inboxes".\n` +
              `If the daemon runs as another user, run as that user, e.g.:\n` +
              `  sudo -u clawcode env HOME=/home/clawcode clawcode a2a orphans`,
          );
          process.exitCode = 1;
          return;
        }
        cliLog("");

        const orphans = await scanOrphanInboxes({ basePath, ownedInboxDirs });
        cliLog(formatOrphanReport(orphans));

        if (opts.archive && orphans.length > 0) {
          cliLog("");
          for (const o of orphans) {
            const moved = await archiveOrphan(o);
            cliLog(`archived ${moved} message(s) from ${o.label} -> ${join(o.path, "orphaned")}`);
          }
        }
      } catch (err) {
        cliError(`Failed to scan for orphaned inboxes: ${(err as Error).message}`);
        process.exitCode = 1;
      }
    });
}
