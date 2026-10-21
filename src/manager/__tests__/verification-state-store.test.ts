/**
 * 999.63d/7 — /clawcode-verify persistence + runtime registry.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  clearVerificationState,
  getVerificationOverride,
  hydrateVerificationOverrides,
  readVerificationState,
  setVerificationOverride,
  writeVerificationState,
} from "../verification-state-store.js";

describe("verification-state store", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clawcode-vs-"));
    file = join(dir, "verification-state.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips an override", async () => {
    await writeVerificationState(file, "fin-client", {
      mode: "topic",
      profile: "finance",
    });
    expect(await readVerificationState(file, "fin-client")).toEqual({
      mode: "topic",
      profile: "finance",
    });
  });

  it("a partial set MERGES — setting profile does not reset mode", async () => {
    await writeVerificationState(file, "a", { mode: "always" });
    await writeVerificationState(file, "a", { profile: "legal" });
    expect(await readVerificationState(file, "a")).toEqual({
      mode: "always",
      profile: "legal",
    });
  });

  it("agents are independent", async () => {
    await writeVerificationState(file, "a", { mode: "always" });
    await writeVerificationState(file, "b", { profile: "legal" });
    expect(await readVerificationState(file, "a")).toEqual({ mode: "always" });
    expect(await readVerificationState(file, "b")).toEqual({ profile: "legal" });
  });

  it("reset drops one agent, leaving others intact", async () => {
    await writeVerificationState(file, "a", { mode: "always" });
    await writeVerificationState(file, "b", { mode: "topic" });
    await clearVerificationState(file, "a");
    expect(await readVerificationState(file, "a")).toBeNull();
    expect(await readVerificationState(file, "b")).toEqual({ mode: "topic" });
  });

  it("one corrupt entry drops only that agent (effort-state IN-01 precedent)", async () => {
    await writeFile(
      file,
      JSON.stringify({
        version: 1,
        updatedAt: "now",
        agents: { good: { mode: "topic" }, bad: { mode: "nonsense" } },
      }),
      "utf8",
    );
    expect(await readVerificationState(file, "good")).toEqual({ mode: "topic" });
    expect(await readVerificationState(file, "bad")).toBeNull();
  });

  it("a missing or unparseable file is not fatal", async () => {
    expect(await readVerificationState(file, "nope")).toBeNull();
    await writeFile(file, "{{{ not json", "utf8");
    expect(await readVerificationState(file, "nope")).toBeNull();
  });

  it("writes atomically — no .tmp left behind", async () => {
    await writeVerificationState(file, "a", { mode: "always" });
    const parsed = JSON.parse(await readFile(file, "utf8"));
    expect(parsed.version).toBe(1);
    expect(parsed.agents.a).toEqual({ mode: "always" });
  });

  it("boot hydration re-applies into the hot-path registry", async () => {
    await writeVerificationState(file, "fin-client", { mode: "topic" });
    setVerificationOverride("fin-client", null); // simulate fresh process
    expect(getVerificationOverride("fin-client")).toBeUndefined();

    await hydrateVerificationOverrides(file);
    expect(getVerificationOverride("fin-client")).toEqual({
      mode: "topic",
    });
  });

  it("registry clear returns an agent to config", async () => {
    setVerificationOverride("x", { mode: "always" });
    expect(getVerificationOverride("x")).toEqual({ mode: "always" });
    setVerificationOverride("x", null);
    expect(getVerificationOverride("x")).toBeUndefined();
  });
});
