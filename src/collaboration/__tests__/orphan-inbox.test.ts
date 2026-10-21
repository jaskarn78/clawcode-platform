/**
 * Phase 999.117 WS-6 — orphaned-inbox detection tests.
 *
 * Motivated by a real finding: 185 messages sat undelivered for three weeks
 * in `~/.clawcode/agents/general/inbox`, addressed to an agent that does not
 * exist. Nothing alerted, nothing counted them, nothing surfaced them.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanOrphanInboxes } from "../orphan-inbox.js";

let base: string;

async function seedInbox(
  agentDir: string,
  messages: Array<{ from: string; ts: number }>,
  nested = false,
): Promise<string> {
  const dir = nested
    ? join(base, agentDir, "memory", "inbox")
    : join(base, agentDir, "inbox");
  await mkdir(dir, { recursive: true });
  for (const [i, m] of messages.entries()) {
    await writeFile(
      join(dir, `${m.ts}-${m.from}-${i}.json`),
      JSON.stringify({ id: `m${i}`, from: m.from, to: agentDir, content: "x", timestamp: m.ts }),
    );
  }
  return dir;
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "orphan-scan-"));
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("scanOrphanInboxes", () => {
  it("finds an inbox no configured agent owns", async () => {
    // The `general` case, reproduced.
    await seedInbox("general", [
      { from: "Admin Clawdy", ts: 1_752_000_000_000 },
      { from: "Admin Clawdy", ts: 1_754_000_000_000 },
    ]);
    const owned = await seedInbox("projects", [{ from: "a", ts: 1 }]);

    const orphans = await scanOrphanInboxes({ basePath: base, ownedInboxDirs: [owned] });

    expect(orphans).toHaveLength(1);
    expect(orphans[0].label).toBe("general");
    expect(orphans[0].pending).toBe(2);
    expect(orphans[0].senders).toEqual(["Admin Clawdy"]);
    expect(orphans[0].oldestAt).toBe(1_752_000_000_000);
    expect(orphans[0].newestAt).toBe(1_754_000_000_000);
  });

  it("does NOT report an inbox that a configured agent owns", async () => {
    const owned = await seedInbox("projects", [{ from: "a", ts: 1 }]);
    const orphans = await scanOrphanInboxes({ basePath: base, ownedInboxDirs: [owned] });
    expect(orphans).toEqual([]);
  });

  it("recognises the nested memory/inbox shape as owned", async () => {
    // memoryPath can point at a nested directory (the acme agents do
    // this). Missing that shape would report a live inbox as an orphan — and
    // this command offers to archive what it finds.
    const owned = await seedInbox("acme", [{ from: "a", ts: 1 }], true);
    const orphans = await scanOrphanInboxes({ basePath: base, ownedInboxDirs: [owned] });
    expect(orphans).toEqual([]);
  });

  it("ignores an empty orphaned directory", async () => {
    // Harmless residue; reporting it would bury the signal that matters.
    await mkdir(join(base, "retired", "inbox"), { recursive: true });
    const orphans = await scanOrphanInboxes({ basePath: base, ownedInboxDirs: [] });
    expect(orphans).toEqual([]);
  });

  it("ranks the biggest backlog first", async () => {
    await seedInbox("small", [{ from: "a", ts: 1 }]);
    await seedInbox("big", [
      { from: "a", ts: 1 },
      { from: "b", ts: 2 },
      { from: "c", ts: 3 },
    ]);
    const orphans = await scanOrphanInboxes({ basePath: base, ownedInboxDirs: [] });
    expect(orphans.map((o) => o.label)).toEqual(["big", "small"]);
  });

  it("returns nothing when the base path does not exist", async () => {
    const orphans = await scanOrphanInboxes({
      basePath: join(base, "nope"),
      ownedInboxDirs: [],
    });
    expect(orphans).toEqual([]);
  });
});
