import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialSlotError,
  activePath,
  markerPath,
  readAccountStatus,
  slotPath,
  snapshotLive,
  summarizeCredentialJson,
  useSlot,
  writeSlot,
} from "../credential-slots.js";

const cred = (refresh: string, expiresAt = Date.now() + 3_600_000, tier = "default_claude_max_20x"): string =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: `at-${refresh}`,
      refreshToken: refresh,
      expiresAt,
      subscriptionType: "max",
      rateLimitTier: tier,
    },
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cred-slots-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("summarizeCredentialJson", () => {
  it("never exposes token values", () => {
    const s = summarizeCredentialJson(cred("secret-refresh-value"));
    expect(JSON.stringify(s)).not.toContain("secret-refresh-value");
    expect(s.refreshSha).toMatch(/^[0-9a-f]{12}$/);
    expect(s.rateLimitTier).toBe("default_claude_max_20x");
  });

  it("marks unparseable content as present but unreadable", () => {
    expect(summarizeCredentialJson("{not json")).toMatchObject({ present: true, readable: false });
  });
});

describe("useSlot (copy-out-then-copy-in, mirrors the shell --use)", () => {
  it("captures the live refresh into the current slot, installs the target, updates the marker", async () => {
    const live = cred("live-main-rotated");
    await writeFile(activePath(dir), live);
    await writeFile(markerPath(dir), "main\n");
    await writeFile(slotPath(dir, "main"), cred("stale-main"));
    await writeFile(slotPath(dir, "admin"), cred("admin-rt", Date.now() + 1000, "default_claude_max_5x"));

    const r = await useSlot(dir, "admin");

    expect(r).toEqual({ changed: true, from: "main", to: "admin" });
    expect(await readFile(slotPath(dir, "main"), "utf-8")).toBe(live);
    expect(JSON.parse(await readFile(activePath(dir), "utf-8")).claudeAiOauth.refreshToken).toBe("admin-rt");
    expect(await readFile(markerPath(dir), "utf-8")).toBe("admin\n");
    expect((await stat(activePath(dir))).mode & 0o777).toBe(0o600);
    expect((await stat(slotPath(dir, "main"))).mode & 0o777).toBe(0o600);
  });

  it("is a no-op when the target is already active", async () => {
    await writeFile(activePath(dir), cred("x"));
    await writeFile(markerPath(dir), "main\n");
    expect(await useSlot(dir, "main")).toEqual({ changed: false, slot: "main" });
  });

  it("refuses when the live credential is unlabeled", async () => {
    await writeFile(activePath(dir), cred("x"));
    await writeFile(slotPath(dir, "admin"), cred("a"));
    await expect(useSlot(dir, "admin")).rejects.toMatchObject({ code: "unlabeled" });
  });

  it("refuses an unseeded target and leaves the live file untouched", async () => {
    await writeFile(activePath(dir), cred("live"));
    await writeFile(markerPath(dir), "main\n");
    await expect(useSlot(dir, "admin")).rejects.toMatchObject({ code: "slot-missing" });
    expect(JSON.parse(await readFile(activePath(dir), "utf-8")).claudeAiOauth.refreshToken).toBe("live");
  });

  it("refuses a target without a refresh token", async () => {
    await writeFile(activePath(dir), cred("live"));
    await writeFile(markerPath(dir), "main\n");
    await writeFile(slotPath(dir, "admin"), JSON.stringify({ claudeAiOauth: {} }));
    await expect(useSlot(dir, "admin")).rejects.toMatchObject({ code: "unreadable" });
  });

  it("refuses when there is no live credential", async () => {
    await expect(useSlot(dir, "admin")).rejects.toMatchObject({ code: "no-active" });
  });

  it("rejects path-traversal slot names", async () => {
    for (const bad of ["..", ".", "../x", "a/b", ""]) {
      await expect(useSlot(dir, bad)).rejects.toBeInstanceOf(CredentialSlotError);
    }
  });

  it("round-trips: switch away and back restores the original account", async () => {
    await writeFile(activePath(dir), cred("main-1"));
    await writeFile(markerPath(dir), "main\n");
    await writeFile(slotPath(dir, "admin"), cred("admin-1"));
    await useSlot(dir, "admin");
    await useSlot(dir, "main");
    expect(JSON.parse(await readFile(activePath(dir), "utf-8")).claudeAiOauth.refreshToken).toBe("main-1");
    expect(JSON.parse(await readFile(slotPath(dir, "admin"), "utf-8")).claudeAiOauth.refreshToken).toBe("admin-1");
  });
});

describe("readAccountStatus / snapshotLive / writeSlot", () => {
  it("flags which slot matches the live refresh token", async () => {
    await writeFile(activePath(dir), cred("live"));
    await writeFile(markerPath(dir), "main\n");
    await writeFile(slotPath(dir, "main"), cred("older"));
    const before = await readAccountStatus(dir, ["main", "admin"]);
    expect(before.activeSlot).toBe("main");
    expect(before.slots.find((s) => s.name === "main")?.matchesLive).toBe(false);
    expect(before.slots.find((s) => s.name === "admin")?.present).toBe(false);

    expect(await snapshotLive(dir)).toBe("main");
    const after = await readAccountStatus(dir, ["main", "admin"]);
    expect(after.slots.find((s) => s.name === "main")?.matchesLive).toBe(true);
  });

  it("writeSlot refuses a credential without a refresh token", async () => {
    await expect(writeSlot(dir, "admin", "{}")).rejects.toMatchObject({ code: "unreadable" });
  });
});
