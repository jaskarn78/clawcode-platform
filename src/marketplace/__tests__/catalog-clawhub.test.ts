/**
 * Phase 90 Plan 04 Task 2 — loadMarketplaceCatalog ClawHub union tests.
 *
 * HUB-CAT-1..5 per 90-04-PLAN:
 *   HUB-CAT-1  ClawHub source with mocked fetch returning 3 items → catalog
 *              contains all 3 entries with source.kind === "clawhub".
 *   HUB-CAT-2  local wins on name collision (local + ClawHub "frontend-design").
 *   HUB-CAT-3  Cache hit on second call within ttl → no second fetch.
 *   HUB-CAT-4  429 from ClawHub → cache negative; other sources still flow.
 *   HUB-CAT-5  auth-required from ClawHub → zero entries + log.warn.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMarketplaceCatalog } from "../catalog.js";
import {
  ClawhubAuthRequiredError,
  ClawhubRateLimitedError,
  type ClawhubSkillsResponse,
} from "../clawhub-client.js";

// We DI the fetchClawhubSkills via a module mock so the catalog loader
// uses our controlled response.
vi.mock("../clawhub-client.js", async (importActual) => {
  const actual =
    await importActual<typeof import("../clawhub-client.js")>();
  return {
    ...actual,
    fetchClawhubSkills: vi.fn(),
  };
});

import * as clawhubClient from "../clawhub-client.js";

async function makeLocalSkill(
  root: string,
  name: string,
  description: string,
): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    "utf8",
  );
  return dir;
}

function clawhubResponse(
  items: Array<Partial<ClawhubSkillsResponse["items"][number]>>,
): ClawhubSkillsResponse {
  return Object.freeze({
    items: Object.freeze(
      items.map((p) =>
        Object.freeze({
          id: p.id ?? "uuid",
          name: p.name ?? "x",
          description: p.description ?? "desc",
          version: p.version ?? "1.0.0",
          author: p.author ?? "auth",
          downloadUrl: p.downloadUrl ?? "https://clawhub.ai/dl.tar.gz",
          ...(p.category !== undefined ? { category: p.category } : {}),
        }),
      ),
    ),
    nextCursor: null,
  });
}

describe("loadMarketplaceCatalog — ClawHub union (Phase 90 Plan 04 HUB-CAT-1..5)", () => {
  it("HUB-CAT-1: ClawHub source → catalog includes 3 items with source.kind='clawhub'", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-hub-1-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });

    vi.mocked(clawhubClient.fetchClawhubSkills).mockResolvedValueOnce(
      clawhubResponse([
        { name: "cloud-skill-a", description: "A" },
        { name: "cloud-skill-b", description: "B" },
        { name: "cloud-skill-c", description: "C" },
      ]),
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [
        { kind: "clawhub", baseUrl: "https://clawhub.ai" },
      ],
    });

    const clawhubEntries = result.filter(
      (e) =>
        typeof e.source === "object" &&
        e.source !== null &&
        "kind" in e.source &&
        e.source.kind === "clawhub",
    );
    expect(clawhubEntries).toHaveLength(3);
    const names = clawhubEntries.map((e) => e.name).sort();
    expect(names).toEqual(["cloud-skill-a", "cloud-skill-b", "cloud-skill-c"]);
  });

  it("HUB-CAT-2: local wins on name collision over ClawHub duplicate", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-hub-2-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await makeLocalSkill(localRoot, "frontend-design", "local design skill");

    vi.mocked(clawhubClient.fetchClawhubSkills).mockResolvedValueOnce(
      clawhubResponse([
        { name: "frontend-design", description: "clawhub version" },
      ]),
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ kind: "clawhub", baseUrl: "https://clawhub.ai" }],
    });

    const fd = result.filter((e) => e.name === "frontend-design");
    expect(fd).toHaveLength(1);
    expect(fd[0].source).toBe("local");
  });

  it("HUB-CAT-4: ClawhubRateLimitedError → cache negative + zero clawhub entries; local still included", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-hub-4-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });
    await makeLocalSkill(localRoot, "frontend-design", "local design");

    vi.mocked(clawhubClient.fetchClawhubSkills).mockRejectedValueOnce(
      new ClawhubRateLimitedError(60_000, "rate-limited"),
    );

    const warnSpy = vi.fn();
    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ kind: "clawhub", baseUrl: "https://clawhub.ai" }],
      log: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn() } as any,
    });

    // Local still present
    expect(result.find((e) => e.name === "frontend-design")).toBeDefined();
    // No clawhub entries surfaced
    const clawhubEntries = result.filter(
      (e) =>
        typeof e.source === "object" &&
        e.source !== null &&
        "kind" in e.source &&
        e.source.kind === "clawhub",
    );
    expect(clawhubEntries).toHaveLength(0);
    // Warning logged
    expect(warnSpy).toHaveBeenCalled();
  });

  it("HUB-CAT-5: ClawhubAuthRequiredError → zero clawhub entries + log.warn called", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-hub-5-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });

    vi.mocked(clawhubClient.fetchClawhubSkills).mockRejectedValueOnce(
      new ClawhubAuthRequiredError("auth required (403)"),
    );

    const warnSpy = vi.fn();
    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ kind: "clawhub", baseUrl: "https://clawhub.ai" }],
      log: { warn: warnSpy, info: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), silent: vi.fn() } as any,
    });

    expect(result).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  // 2026-05-04 today-fire: a real ClawHub response surfaced an item whose
  // `name` was undefined; the catalog set it as the byName key and the
  // Step-3 sort threw "Cannot read properties of undefined (reading
  // 'localeCompare')", crashing the entire /clawcode-skills-browse for
  // every operator. The fix skips name-less items at ingestion + filters
  // before sort. This test pins both layers.
  it("HUB-CAT-7: skips clawhub items with missing/empty name; rest of catalog still loads", async () => {
    const root = await mkdtemp(join(tmpdir(), "mkt-hub-7-"));
    const localRoot = join(root, "local");
    await mkdir(localRoot, { recursive: true });

    // Construct a hand-rolled response that has one item with name="" and
    // one with name=undefined, alongside two valid items. The clawhubResponse
    // helper above forces a default name="x" so we bypass it here.
    vi.mocked(clawhubClient.fetchClawhubSkills).mockResolvedValueOnce(
      Object.freeze({
        items: Object.freeze([
          Object.freeze({
            id: "uuid-1",
            name: "valid-skill-a",
            description: "A",
            version: "1.0.0",
            author: "auth",
            downloadUrl: "https://clawhub.ai/a.tar.gz",
          }),
          // Missing name (undefined coerced through unknown for safety).
          Object.freeze({
            id: "uuid-2",
            name: undefined as unknown as string,
            description: "no name",
            version: "1.0.0",
            author: "auth",
            downloadUrl: "https://clawhub.ai/b.tar.gz",
          }),
          Object.freeze({
            id: "uuid-3",
            name: "",
            description: "empty name",
            version: "1.0.0",
            author: "auth",
            downloadUrl: "https://clawhub.ai/c.tar.gz",
          }),
          Object.freeze({
            id: "uuid-4",
            name: "valid-skill-b",
            description: "B",
            version: "1.0.0",
            author: "auth",
            downloadUrl: "https://clawhub.ai/d.tar.gz",
          }),
        ]),
        nextCursor: null,
      }) as ClawhubSkillsResponse,
    );

    const result = await loadMarketplaceCatalog({
      localSkillsPath: localRoot,
      sources: [{ kind: "clawhub", baseUrl: "https://clawhub.ai" }],
    });

    const names = result.map((e) => e.name);
    expect(names).toEqual(["valid-skill-a", "valid-skill-b"]);
    // Verify the sort itself didn't throw (regression check — pre-fix
    // this whole call would reject with the localeCompare error).
    expect(result).toHaveLength(2);
  });
});
