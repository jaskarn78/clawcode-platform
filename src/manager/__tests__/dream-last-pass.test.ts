/**
 * dream-last-pass: the per-agent "last applied dream pass" record the
 * novelty gate reads. Uses the dirOverride seam so the real manager dir is
 * never touched.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DREAM_LAST_PASS_FILE,
  readLastDreamPass,
  writeLastDreamPass,
} from "../dream-last-pass.js";

describe("dream-last-pass", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "dream-last-pass-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when no record exists", async () => {
    expect(await readLastDreamPass("atlas", dir)).toBeNull();
  });

  it("round-trips a record per agent and keeps other agents' records", async () => {
    await writeLastDreamPass("atlas", "2026-10-25T10:00:00.000Z", dir);
    await writeLastDreamPass("beta", "2026-10-25T11:00:00.000Z", dir);
    await writeLastDreamPass("atlas", "2026-10-25T12:00:00.000Z", dir);
    expect(await readLastDreamPass("atlas", dir)).toBe("2026-10-25T12:00:00.000Z");
    expect(await readLastDreamPass("beta", dir)).toBe("2026-10-25T11:00:00.000Z");
    expect(await readLastDreamPass("gamma", dir)).toBeNull();
    // One small JSON file, no leftover tmp files.
    expect(readdirSync(dir)).toEqual([DREAM_LAST_PASS_FILE]);
    const parsed = JSON.parse(readFileSync(join(dir, DREAM_LAST_PASS_FILE), "utf8"));
    expect(parsed.version).toBe(1);
  });

  it("treats a malformed file as empty and overwrites it on the next write", async () => {
    writeFileSync(join(dir, DREAM_LAST_PASS_FILE), "{ not json", "utf8");
    expect(await readLastDreamPass("atlas", dir)).toBeNull();
    await writeLastDreamPass("atlas", "2026-10-25T10:00:00.000Z", dir);
    expect(await readLastDreamPass("atlas", dir)).toBe("2026-10-25T10:00:00.000Z");
  });

  it("ignores entries without a string lastPassAt", async () => {
    writeFileSync(
      join(dir, DREAM_LAST_PASS_FILE),
      JSON.stringify({ version: 1, agents: { atlas: { lastPassAt: 42 }, beta: null } }),
      "utf8",
    );
    expect(await readLastDreamPass("atlas", dir)).toBeNull();
    expect(await readLastDreamPass("beta", dir)).toBeNull();
  });

  it("keeps every agent when many agents finish a pass at the same moment", async () => {
    // All agents' crons fire on the same minute; the shared file must not
    // lose an agent to a read-modify-write race.
    const agents = Array.from({ length: 12 }, (_, i) => `agent-${i}`);
    await Promise.all(
      agents.map((a, i) =>
        writeLastDreamPass(a, new Date(Date.UTC(2026, 9, 25, 10, i)).toISOString(), dir),
      ),
    );
    for (const [i, a] of agents.entries()) {
      expect(await readLastDreamPass(a, dir)).toBe(new Date(Date.UTC(2026, 9, 25, 10, i)).toISOString());
    }
  });

  it("never moves a record backwards in time", async () => {
    await writeLastDreamPass("atlas", "2026-10-25T12:00:00.000Z", dir);
    // An overlapping manual pass that started earlier but finished later.
    await writeLastDreamPass("atlas", "2026-10-25T11:00:00.000Z", dir);
    expect(await readLastDreamPass("atlas", dir)).toBe("2026-10-25T12:00:00.000Z");
  });

  it("never throws when the directory cannot be created", async () => {
    await expect(
      writeLastDreamPass("atlas", "2026-10-25T10:00:00.000Z", join(dir, "blocked", "\0bad")),
    ).resolves.toBeUndefined();
  });
});
