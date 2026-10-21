/**
 * Phase 999.164 — the /clawcode-quick override persists per agent, survives a
 * restart (hydrate), clears back to config, and wins over config while set.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearFastLaneState,
  getFastLaneOverride,
  hydrateFastLaneOverrides,
  readAllFastLaneState,
  resolveFastLaneEnabled,
  setFastLaneOverride,
  writeFastLaneState,
} from "../fast-lane-state-store.js";

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fast-lane-state-"));
  path = join(dir, "manager", "fast-lane-state.json");
  setFastLaneOverride("fin-client", null);
  setFastLaneOverride("personal", null);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("fast-lane state store", () => {
  it("persists per-agent overrides and reads them back", async () => {
    await writeFastLaneState(path, "fin-client", { enabled: false });
    await writeFastLaneState(path, "personal", { enabled: true });
    expect(await readAllFastLaneState(path)).toEqual({ "fin-client": { enabled: false }, personal: { enabled: true } });
  });

  it("clear drops only that agent", async () => {
    await writeFastLaneState(path, "fin-client", { enabled: false });
    await writeFastLaneState(path, "personal", { enabled: false });
    await clearFastLaneState(path, "fin-client");
    expect(await readAllFastLaneState(path)).toEqual({ personal: { enabled: false } });
    await clearFastLaneState(path, "never-set"); // no-op, no throw
  });

  it("a missing or corrupt file reads as no overrides", async () => {
    expect(await readAllFastLaneState(path)).toEqual({});
    await writeFastLaneState(path, "personal", { enabled: false });
    await writeFile(path, "{not json", "utf8");
    expect(await readAllFastLaneState(path)).toEqual({});
  });

  it("one bad entry drops only that agent", async () => {
    await writeFastLaneState(path, "personal", { enabled: false });
    const file = JSON.parse(await readFile(path, "utf8"));
    file.agents["fin-client"] = { enabled: "nope" };
    await writeFile(path, JSON.stringify(file), "utf8");
    expect(await readAllFastLaneState(path)).toEqual({ personal: { enabled: false } });
  });

  it("hydrate re-applies persisted overrides to the in-memory registry (restart survival)", async () => {
    await writeFastLaneState(path, "fin-client", { enabled: false });
    expect(getFastLaneOverride("fin-client")).toBeUndefined();
    await hydrateFastLaneOverrides(path);
    expect(getFastLaneOverride("fin-client")).toEqual({ enabled: false });
  });
});

describe("resolveFastLaneEnabled", () => {
  it("the override wins over config in both directions; without one, config decides", () => {
    expect(resolveFastLaneEnabled({ enabled: false }, true)).toEqual({ enabled: false, source: "override" });
    expect(resolveFastLaneEnabled({ enabled: true }, false)).toEqual({ enabled: true, source: "override" });
    expect(resolveFastLaneEnabled(undefined, true)).toEqual({ enabled: true, source: "config" });
    expect(resolveFastLaneEnabled(undefined, undefined)).toEqual({ enabled: false, source: "config" });
  });
});
