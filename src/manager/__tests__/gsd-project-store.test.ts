/**
 * Phase 100 follow-up — gsd-project-overrides persistence tests.
 *
 * Mirrors `effort-state-store.test.ts` shape byte-for-byte. The override file
 * lives alongside `effort-state.json` at
 * `~/.clawcode/manager/gsd-project-overrides.json` and carries a versioned +
 * atomic shape:
 *
 * ```json
 * {
 *   "version": 1,
 *   "updatedAt": "2026-04-26T19:11:34Z",
 *   "agents": {
 *     "Admin Clawdy": "/opt/clawcode-projects/sandbox",
 *     "fin-client": "/home/example-user/.openclaw/workspace-acme"
 *   }
 * }
 * ```
 *
 * Invariants pinned by these tests:
 *   - Round-trip write → read returns the same projectDir
 *   - Missing file → `null` (no throw)
 *   - Corrupt JSON → `null` + warn (non-fatal)
 *   - Atomic temp+rename — writes are visible only after rename
 *   - Two agents can coexist without mutual overwrite
 *   - readAllOverrides returns an empty Map on missing file
 *   - readAllOverrides returns the map of all override entries
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { nanoid } from "nanoid";
import {
  readGsdProjectOverride,
  writeGsdProjectOverride,
  readAllGsdProjectOverrides,
} from "../gsd-project-store.js";

describe("gsd-project-store — atomic JSON round-trip", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), `gsd-project-store-${nanoid()}-`));
    filePath = join(tmpDir, "gsd-project-overrides.json");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("writeGsdProjectOverride → readGsdProjectOverride round-trips the projectDir", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    const got = await readGsdProjectOverride(filePath, "Admin Clawdy");
    expect(got).toBe("/opt/clawcode-projects/sandbox");
  });

  it("two agents coexist without mutual overwrite", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    await writeGsdProjectOverride(filePath, "fin-client", "/home/example-user/.openclaw/workspace-acme");
    expect(await readGsdProjectOverride(filePath, "Admin Clawdy")).toBe("/opt/clawcode-projects/sandbox");
    expect(await readGsdProjectOverride(filePath, "fin-client")).toBe("/home/example-user/.openclaw/workspace-acme");
  });

  it("missing file → null (no throw)", async () => {
    const got = await readGsdProjectOverride(join(tmpDir, "does-not-exist.json"), "Admin Clawdy");
    expect(got).toBeNull();
  });

  it("missing agent in existing file → null", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    const got = await readGsdProjectOverride(filePath, "fin-client");
    expect(got).toBeNull();
  });

  it("corrupt JSON → null (no throw)", async () => {
    await writeFile(filePath, "{not valid json", "utf8");
    const got = await readGsdProjectOverride(filePath, "Admin Clawdy");
    expect(got).toBeNull();
  });

  it("invalid top-level schema → null", async () => {
    await writeFile(filePath, JSON.stringify({ wrong: "shape" }), "utf8");
    const got = await readGsdProjectOverride(filePath, "Admin Clawdy");
    expect(got).toBeNull();
  });

  it("file shape on disk matches the documented schema", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    const raw = await readFile(filePath, "utf8");
    const obj = JSON.parse(raw);
    expect(obj.version).toBe(1);
    expect(typeof obj.updatedAt).toBe("string");
    expect(obj.agents["Admin Clawdy"]).toBe("/opt/clawcode-projects/sandbox");
  });

  it("atomic write — no .tmp file remains after writeGsdProjectOverride", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tmpDir);
    const tmps = entries.filter((e) => e.endsWith(".tmp"));
    expect(tmps).toHaveLength(0);
  });

  it("readAllGsdProjectOverrides returns empty Map on missing file", async () => {
    const map = await readAllGsdProjectOverrides(join(tmpDir, "does-not-exist.json"));
    expect(map.size).toBe(0);
  });

  it("readAllGsdProjectOverrides returns the full map of overrides", async () => {
    await writeGsdProjectOverride(filePath, "Admin Clawdy", "/opt/clawcode-projects/sandbox");
    await writeGsdProjectOverride(filePath, "fin-client", "/home/example-user/.openclaw/workspace-acme");
    const map = await readAllGsdProjectOverrides(filePath);
    expect(map.size).toBe(2);
    expect(map.get("Admin Clawdy")).toBe("/opt/clawcode-projects/sandbox");
    expect(map.get("fin-client")).toBe("/home/example-user/.openclaw/workspace-acme");
  });
});
