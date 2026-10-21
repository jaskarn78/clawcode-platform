import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeActiveStateYaml,
  readActiveStateYaml,
  ACTIVE_STATE_SENTINEL,
} from "../yaml-writer.js";
import type { ActiveStateBlock } from "../types.js";

const sampleBlock = (): ActiveStateBlock =>
  Object.freeze({
    primaryClient: "Acme",
    inFlightTasks: Object.freeze(["I'll draft the email", "next: send to Client A"]),
    standingRulesAddedToday: Object.freeze(["rule: never email after 8pm"]),
    driveFoldersTouched: Object.freeze(["clients/Acme/"]),
    lastOperatorMessages: Object.freeze(["msg-a", "msg-b", "msg-c"]),
    lastAgentCommitments: Object.freeze(["I'll draft the email"]),
    generatedAt: "2026-05-14T15:00:00.000Z",
  });

describe("writeActiveStateYaml + readActiveStateYaml", () => {
  let baseDir: string;
  const clock = () => new Date("2026-05-14T15:00:00Z");

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), "active-state-"));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("write+read round-trips block fields", async () => {
    const block = sampleBlock();
    const writtenPath = await writeActiveStateYaml("agent-a", block, {
      baseDir,
      fs: fsPromises,
      clock,
    });
    expect(writtenPath.endsWith("agent-a/state/active-state.yaml")).toBe(true);
    const round = await readActiveStateYaml("agent-a", {
      baseDir,
      fs: fsPromises,
    });
    expect(round).not.toBeNull();
    expect(round?.primaryClient).toBe("Acme");
    expect(round?.inFlightTasks).toEqual([
      "I'll draft the email",
      "next: send to Client A",
    ]);
    expect(round?.lastOperatorMessages).toEqual(["msg-a", "msg-b", "msg-c"]);
    expect(round?.generatedAt).toBe("2026-05-14T15:00:00.000Z");
  });

  it("leaves no .tmp file after successful write (atomic rename)", async () => {
    await writeActiveStateYaml("agent-b", sampleBlock(), {
      baseDir,
      fs: fsPromises,
      clock,
    });
    const stateDir = join(baseDir, "agent-b", "state");
    const entries = readdirSync(stateDir);
    expect(entries).toContain("active-state.yaml");
    expect(entries.some((e) => e.endsWith(".tmp"))).toBe(false);
  });

  it("readActiveStateYaml returns null when file is missing", async () => {
    const result = await readActiveStateYaml("never-written", {
      baseDir,
      fs: fsPromises,
    });
    expect(result).toBeNull();
  });

  it("readActiveStateYaml returns null on parse failure (no throw)", async () => {
    const dir = join(baseDir, "broken", "state");
    await fsPromises.mkdir(dir, { recursive: true });
    await fsPromises.writeFile(
      join(dir, "active-state.yaml"),
      "this: is: not: valid: yaml: [unbalanced",
      "utf8",
    );
    const result = await readActiveStateYaml("broken", {
      baseDir,
      fs: fsPromises,
    });
    expect(result).toBeNull();
  });

  it("output includes the sentinel comment", async () => {
    const path = await writeActiveStateYaml("agent-c", sampleBlock(), {
      baseDir,
      fs: fsPromises,
      clock,
    });
    const raw = await fsPromises.readFile(path, "utf8");
    expect(raw).toContain(ACTIVE_STATE_SENTINEL);
    expect(raw.startsWith("# sentinel:")).toBe(true);
  });

  it("two concurrent writes both succeed and leave one final file", async () => {
    const a = writeActiveStateYaml("agent-d", sampleBlock(), {
      baseDir,
      fs: fsPromises,
      clock,
    });
    const b = writeActiveStateYaml("agent-d", sampleBlock(), {
      baseDir,
      fs: fsPromises,
      clock: () => new Date("2026-05-14T15:00:01Z"),
    });
    await Promise.all([a, b]);
    const stateDir = join(baseDir, "agent-d", "state");
    const entries = readdirSync(stateDir);
    expect(entries).toContain("active-state.yaml");
    expect(entries.filter((e) => e.endsWith(".tmp")).length).toBe(0);
    expect(
      existsSync(join(stateDir, "active-state.yaml")),
    ).toBe(true);
  });
});
