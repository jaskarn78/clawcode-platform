/**
 * Phase 999.39 — one-shot cleanup of memory entries polluted with
 * "Credit balance is too low" errors from the consolidation worker
 * hitting the metered ANTHROPIC_API_KEY path (now fixed).
 *
 * Reads memoryPath for each agent from clawcode.yaml, opens memories.db,
 * deletes rows whose content matches the credit-error patterns, and reports
 * counts. Run once after deploying the Phase 999.39 fix, then delete.
 *
 * Usage:  npx tsx scripts/cleanup-credit-errors.ts
 *         npx tsx scripts/cleanup-credit-errors.ts --dry-run
 */

import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseYaml } from "yaml";

const DRY_RUN = process.argv.includes("--dry-run");

const CREDIT_ERROR_PATTERNS = [
  "%Credit balance is too low%",
  "%credit_balance_is_too_low%",
  "%insufficient_quota%",
  "%Your credit balance is%",
];

async function loadAgentMemoryPaths(): Promise<Map<string, string>> {
  // Try workspace-local clawcode.yaml first, then /etc/clawcode/clawcode.yaml
  const candidates = [
    join(process.cwd(), "clawcode.yaml"),
    "/etc/clawcode/clawcode.yaml",
    join(homedir(), ".clawcode", "clawcode.yaml"),
  ];

  let raw: string | null = null;
  let src = "";
  for (const p of candidates) {
    if (existsSync(p)) {
      raw = await readFile(p, "utf-8");
      src = p;
      break;
    }
  }
  if (!raw) throw new Error("clawcode.yaml not found in any candidate location");
  console.log(`Reading config from: ${src}`);

  const cfg = parseYaml(raw) as Record<string, unknown>;
  const agents = (cfg["agents"] as unknown[]) ?? [];
  const result = new Map<string, string>();

  for (const agent of agents) {
    if (typeof agent !== "object" || agent === null) continue;
    const a = agent as Record<string, unknown>;
    const name = typeof a["name"] === "string" ? a["name"] : null;
    const memoryPath = typeof a["memoryPath"] === "string" ? a["memoryPath"] : null;
    if (name && memoryPath) result.set(name, memoryPath);
  }
  return result;
}

function cleanAgent(agentName: string, memoryPath: string): number {
  const dbPath = join(memoryPath, "memories.db");
  if (!existsSync(dbPath)) {
    console.log(`  ${agentName}: no memories.db at ${dbPath} — skipped`);
    return 0;
  }

  const db = new Database(dbPath);
  let totalDeleted = 0;

  try {
    for (const pattern of CREDIT_ERROR_PATTERNS) {
      const countRow = db
        .prepare("SELECT COUNT(*) as n FROM memory_chunks WHERE content LIKE ?")
        .get(pattern) as { n: number };
      const count = countRow.n;
      if (count > 0) {
        console.log(
          `  ${agentName}: found ${count} rows matching pattern "${pattern}"` +
            (DRY_RUN ? " (dry-run, not deleted)" : " — deleting"),
        );
        if (!DRY_RUN) {
          const result = db
            .prepare("DELETE FROM memory_chunks WHERE content LIKE ?")
            .run(pattern);
          totalDeleted += result.changes;
        } else {
          totalDeleted += count;
        }
      }
    }
    if (totalDeleted === 0) {
      console.log(`  ${agentName}: clean — no credit error rows found`);
    }
  } finally {
    db.close();
  }
  return totalDeleted;
}

async function main() {
  console.log(`Phase 999.39 credit-error cleanup${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  const agentPaths = await loadAgentMemoryPaths();
  if (agentPaths.size === 0) {
    console.log("No agents with memoryPath found in clawcode.yaml");
    return;
  }

  let grand = 0;
  for (const [name, memPath] of agentPaths) {
    grand += cleanAgent(name, memPath);
  }

  console.log(
    `\nDone. Total rows ${DRY_RUN ? "found" : "deleted"}: ${grand}`,
  );
}

main().catch((err) => {
  console.error("cleanup-credit-errors failed:", err);
  process.exit(1);
});
