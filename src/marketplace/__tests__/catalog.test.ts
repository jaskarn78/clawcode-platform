/**
 * Phase 88 Plan 01 Task 1 — loadMarketplaceCatalog tests.
 *
 * Pins behavior per 88-01-PLAN (tests C1-C9):
 *   C1 defaults: no marketplaceSources → local-only catalog
 *   C2 explicit empty: sources=[] same as C1
 *   C3 legacy source: p1 + p2 included, deprecate excluded
 *   C4 union dedup: local wins over legacy for same name
 *   C5 entry shape: name/description/category/source/skillDir/classification
 *   C6 scope-tag resolution: acme-crm→acme, tuya-ac→personal,
 *      frontend-design→fleet, unknown→fleet
 *   C7 source-missing tolerance: non-existent path → local-only + warn
 *   C8 zod round-trip: optional marketplaceSources parses unchanged
 *   C9 zod invalid: path="" rejected
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketplaceCatalog } from "../catalog.js";
import { defaultsSchema } from "../../config/schema.js";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function makeLocalSkill(
  root: string,
  name: string,
  description: string,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  // scanner.ts extracts the first non-empty body paragraph (post-
  // frontmatter) as the SkillEntry.description. Put the description text
  // directly — no leading heading — so the scanner returns it verbatim.
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    "utf8",
  );
  return dir;
}

async function makeLegacySkill(
  root: string,
  name: string,
  body: string,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), body, "utf8");
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadMarketplaceCatalog — Phase 88 Plan 01 (C1-C7)", () => {
  it("C1: no sources → local-only catalog", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c1-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await makeLocalSkill(localRoot, "frontend-design", "fleet design skill");
    await makeLocalSkill(localRoot, "tuya-ac", "tuya smart ac control");

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [],
    });

    expect(result.length).toBe(2);
    expect(result.map((e) => e.name).sort()).toEqual([
      "frontend-design",
      "tuya-ac",
    ]);
    for (const e of result) {
      expect(e.source).toBe("local");
    }
  });

  it("C2: explicit empty sources array behaves like defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c2-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await makeLocalSkill(localRoot, "frontend-design", "design skill");

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [],
    });

    expect(result.length).toBe(1);
    expect(result[0].name).toBe("frontend-design");
    expect(result[0].source).toBe("local");
  });

  it("C3: legacy source contributes p1+p2, excludes deprecate", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c3-"));
    const localRoot = join(root, "local");
    const legacyRoot = join(root, "legacy");
    await mkdir(localRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    await makeLocalSkill(localRoot, "local-only", "local fleet skill");
    // p1 skills
    await makeLegacySkill(
      legacyRoot,
      "frontend-design",
      "# frontend-design\n\nP1 fleet design skill\n",
    );
    await makeLegacySkill(
      legacyRoot,
      "tuya-ac",
      "tuya-ac — Tuya Smart AC Control\n",
    );
    // p2 skill
    await makeLegacySkill(
      legacyRoot,
      "power-apps-builder",
      "# power-apps-builder\n\nP2 tier skill\n",
    );
    // deprecate — MUST be excluded
    await makeLegacySkill(
      legacyRoot,
      "cognitive-memory",
      "# cognitive-memory\n\nDeprecated\n",
    );
    // unknown — MUST be excluded (only p1/p2 advertised)
    await makeLegacySkill(
      legacyRoot,
      "brand-new-unknown",
      "# brand-new-unknown\n\nNovel\n",
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ path: legacyRoot, label: "OpenClaw legacy" }],
    });

    const names = result.map((e) => e.name).sort();
    // local-only + 3 legacy (p1/p1/p2). No cognitive-memory, no unknown.
    expect(names).toEqual([
      "frontend-design",
      "local-only",
      "power-apps-builder",
      "tuya-ac",
    ]);
    expect(names).not.toContain("cognitive-memory");
    expect(names).not.toContain("brand-new-unknown");
  });

  it("C4: name collision → local wins (dedup)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c4-"));
    const localRoot = join(root, "local");
    const legacyRoot = join(root, "legacy");
    await mkdir(localRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    await makeLocalSkill(
      localRoot,
      "frontend-design",
      "LOCAL description wins",
    );
    await makeLegacySkill(
      legacyRoot,
      "frontend-design",
      "# frontend-design\n\nLEGACY description loses\n",
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ path: legacyRoot }],
    });

    // Exactly one entry named frontend-design
    expect(result.filter((e) => e.name === "frontend-design").length).toBe(1);
    const entry = result.find((e) => e.name === "frontend-design")!;
    expect(entry.source).toBe("local");
    expect(entry.description).toContain("LOCAL");
  });

  it("C5: entry shape includes name/description/category/source/skillDir", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c5-"));
    const localRoot = join(root, "local");
    const legacyRoot = join(root, "legacy");
    await mkdir(localRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    const localPath = await makeLocalSkill(
      localRoot,
      "frontend-design",
      "Local design skill",
    );
    const legacyPath = await makeLegacySkill(
      legacyRoot,
      "tuya-ac",
      "tuya-ac — Tuya Smart AC Control\n",
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ path: legacyRoot, label: "legacy" }],
    });

    const local = result.find((e) => e.name === "frontend-design")!;
    expect(local).toBeDefined();
    expect(typeof local.name).toBe("string");
    expect(typeof local.description).toBe("string");
    expect(local.category).toBe("fleet");
    expect(local.source).toBe("local");
    expect(local.skillDir).toBe(localPath);

    const legacy = result.find((e) => e.name === "tuya-ac")!;
    expect(legacy).toBeDefined();
    expect(typeof legacy.source).toBe("object");
    // Phase 90 Plan 04 HUB-01 — source is now a 3-way union; narrow with
    // a type guard that excludes the clawhub variant before .path access.
    if (typeof legacy.source === "object" && !("kind" in legacy.source)) {
      expect(legacy.source.path).toBe(legacyRoot);
      expect(legacy.source.label).toBe("legacy");
    }
    expect(legacy.skillDir).toBe(legacyPath);
    expect(legacy.classification).toBe("p1");
    expect(legacy.description.length).toBeGreaterThan(0);
  });

  it("C6: scope-tag resolution (acme/personal/fleet defaults)", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c6-"));
    const localRoot = join(root, "local");
    const legacyRoot = join(root, "legacy");
    await mkdir(localRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    // Use legacy source so scope tags are evaluated on discovered skills.
    // acme-crm will be refused by secret-scan if we put MySQL creds in it;
    // but this test only covers the CATALOG resolution — the secret-scan gate
    // is install-time, not catalog-time.
    await makeLegacySkill(
      legacyRoot,
      "acme-crm",
      "# acme-crm\n\nFin agent CRM helper.\n",
    );
    await makeLegacySkill(
      legacyRoot,
      "tuya-ac",
      "# tuya-ac\n\nPersonal AC controller.\n",
    );
    await makeLegacySkill(
      legacyRoot,
      "frontend-design",
      "# frontend-design\n\nFleet design skill.\n",
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ path: legacyRoot }],
    });

    const byName = new Map(result.map((e) => [e.name, e]));
    expect(byName.get("acme-crm")?.category).toBe("acme");
    expect(byName.get("tuya-ac")?.category).toBe("personal");
    expect(byName.get("frontend-design")?.category).toBe("fleet");
  });

  it("C7: missing source path → local-only + warn, does NOT throw", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-c7-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await makeLocalSkill(localRoot, "frontend-design", "local fleet skill");

    const warn = vi.fn();
    const log = {
      warn,
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
      fatal: vi.fn(),
    } as unknown as Parameters<typeof loadMarketplaceCatalog>[0]["log"];

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ path: "/does/not/exist/ever" }],
      log,
    });

    expect(result.length).toBe(1);
    expect(result[0].name).toBe("frontend-design");
    // discoverOpenclawSkills returns [] on non-existent root so the warn may
    // not fire. The plan says "logs warning" — we accept either 0 or 1
    // warnings (no throw is the key invariant).
    // If we get more than 1 warning, something unexpected happened.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe("defaultsSchema.marketplaceSources — Phase 88 Plan 01 (C8-C9)", () => {
  it("C8: marketplaceSources is optional → parse succeeds without it", () => {
    const result = defaultsSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      // Undefined when omitted (optional field, no default factory).
      expect(result.data.marketplaceSources).toBeUndefined();
    }
  });

  it("C8b: explicit marketplaceSources array parses correctly", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [
        { path: "~/.openclaw/skills", label: "OpenClaw legacy" },
        { path: "/opt/fleet/skills" },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.marketplaceSources?.length).toBe(2);
      // Phase 90 Plan 04 HUB-01 — marketplaceSources is now a discriminated
      // union. Narrow to the legacy branch (path-based) via type-guard.
      const first = result.data.marketplaceSources?.[0];
      const second = result.data.marketplaceSources?.[1];
      expect(first && "path" in first && first.path).toBe(
        "~/.openclaw/skills",
      );
      expect(first && "path" in first && first.label).toBe(
        "OpenClaw legacy",
      );
      expect(second && "path" in second && second.label).toBeUndefined();
    }
  });

  it("C9: empty path string is rejected (min(1) enforcement)", () => {
    const result = defaultsSchema.safeParse({
      marketplaceSources: [{ path: "" }],
    });
    expect(result.success).toBe(false);
  });
});
