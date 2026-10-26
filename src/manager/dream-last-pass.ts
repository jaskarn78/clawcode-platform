/**
 * Per-agent record of the last APPLIED dream pass.
 *
 * WHY THIS EXISTS: the idle cron fired a dream pass on every tick for as
 * long as an agent stayed idle (50 to 80 passes a day per idle agent on the
 * live host, 9,077 applied runs), each on near-identical input. The dream
 * machinery consults this record in its novelty gate: a tick is skipped
 * unless a memory_chunks or memories row was written after the last pass,
 * with a floor of one pass per DREAM_PASS_FLOOR_MS so an idle agent still
 * reflects a few times a day.
 *
 * Storage: `~/.clawcode/manager/dream-last-pass.json`, one object keyed by
 * agent name. Same `dirOverride` seam as dream-run-log.ts so tests never
 * touch the real manager dir. Writes are atomic (tmp + rename). Reads
 * tolerate a missing or malformed file (treated as "never dreamt").
 */

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export const DREAM_LAST_PASS_FILE = "dream-last-pass.json";

interface LastPassFile {
  readonly version: 1;
  readonly agents: Readonly<Record<string, { readonly lastPassAt: string }>>;
}

function resolvePath(dirOverride?: string): { dir: string; file: string } {
  const dir = dirOverride ?? join(homedir(), ".clawcode", "manager");
  return { dir, file: join(dir, DREAM_LAST_PASS_FILE) };
}

async function readFileTolerant(file: string): Promise<LastPassFile> {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<LastPassFile>;
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.agents &&
      typeof parsed.agents === "object"
    ) {
      const agents: Record<string, { lastPassAt: string }> = {};
      for (const [name, v] of Object.entries(parsed.agents)) {
        const lastPassAt = (v as { lastPassAt?: unknown } | null)?.lastPassAt;
        if (typeof lastPassAt === "string") agents[name] = { lastPassAt };
      }
      return { version: 1, agents };
    }
  } catch {
    // ENOENT or malformed JSON: treated as empty below.
  }
  return { version: 1, agents: {} };
}

/**
 * ISO timestamp of the agent's last applied dream pass, or null when the
 * agent has never completed one (or the file is missing / unreadable).
 */
export async function readLastDreamPass(
  agent: string,
  dirOverride?: string,
): Promise<string | null> {
  const { file } = resolvePath(dirOverride);
  const data = await readFileTolerant(file);
  return data.agents[agent]?.lastPassAt ?? null;
}

/**
 * Record the agent's last applied dream pass. Never throws: a failed write
 * only means the next daemon boot starts from "never dreamt", which the
 * novelty gate treats as "run once".
 */
export async function writeLastDreamPass(
  agent: string,
  lastPassAt: string,
  dirOverride?: string,
): Promise<void> {
  try {
    const { dir, file } = resolvePath(dirOverride);
    await fs.mkdir(dir, { recursive: true });
    const current = await readFileTolerant(file);
    const next: LastPassFile = {
      version: 1,
      agents: { ...current.agents, [agent]: { lastPassAt } },
    };
    const tmp = `${file}.tmp.${randomBytes(4).toString("hex")}`;
    await fs.writeFile(tmp, JSON.stringify(next, null, 2) + "\n", "utf8");
    try {
      await fs.rename(tmp, file);
    } catch (err) {
      await fs.unlink(tmp).catch(() => {});
      throw err;
    }
  } catch {
    // Deliberate swallow: bookkeeping must never break a dream pass.
  }
}
