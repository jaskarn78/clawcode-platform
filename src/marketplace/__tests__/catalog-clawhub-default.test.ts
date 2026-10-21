/**
 * Phase 93 Plan 02 — loadMarketplaceCatalog auto-inject contract (C-01..C-05).
 *
 * Pins per CONTEXT.md D-93-02-1..4:
 *   - Inject only when sources lack kind:"clawhub" AND defaultClawhubBaseUrl set
 *   - Synthetic source carries NO authToken (public access)
 *   - Back-compat unchanged when either condition fails
 *   - Local wins on name collision (auto-injected source uses same precedence)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../clawhub-client.js", async (importActual) => {
  const actual = await importActual<typeof import("../clawhub-client.js")>();
  return { ...actual, fetchClawhubSkills: vi.fn() };
});

import { loadMarketplaceCatalog } from "../catalog.js";
import * as clawhubClient from "../clawhub-client.js";
import type { ClawhubSkillsResponse } from "../clawhub-client.js";
import type { ResolvedMarketplaceSources } from "../../shared/types.js";

const mockedFetch = vi.mocked(clawhubClient.fetchClawhubSkills);

function clawhubResp(
  items: Array<{ name: string; description: string }>,
): ClawhubSkillsResponse {
  return Object.freeze({
    items: Object.freeze(
      items.map((p) =>
        Object.freeze({
          id: `id-${p.name}`,
          name: p.name,
          description: p.description,
          version: "1.0.0",
          author: "auth",
          downloadUrl: `https://clawhub.ai/api/v1/skills/${p.name}/download`,
        }),
      ),
    ) as unknown as ClawhubSkillsResponse["items"],
    nextCursor: null,
  });
}

async function makeLocalSkill(
  root: string,
  name: string,
  description: string,
): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`,
    "utf8",
  );
}

describe("loadMarketplaceCatalog — Phase 93 Plan 02 auto-inject", () => {
  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it("C-01 auto-injects when sources has no kind:'clawhub' + defaultClawhubBaseUrl set", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "skills-c01-"));
    await makeLocalSkill(localDir, "local-only", "local desc");
    mockedFetch.mockResolvedValue(
      clawhubResp([
        { name: "alpha", description: "a" },
        { name: "beta", description: "b" },
      ]),
    );

    const out = await loadMarketplaceCatalog({
      localSkillsPath: localDir,
      sources: [] as unknown as ResolvedMarketplaceSources,
      defaultClawhubBaseUrl: "https://clawhub.ai",
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const callArgs = mockedFetch.mock.calls[0]![0]!;
    expect(callArgs.baseUrl).toBe("https://clawhub.ai");
    expect(out.map((e) => e.name).sort()).toEqual([
      "alpha",
      "beta",
      "local-only",
    ]);
  });

  it("C-02 does NOT inject when sources already contains kind:'clawhub'", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "skills-c02-"));
    mockedFetch.mockResolvedValue(
      clawhubResp([{ name: "explicit", description: "e" }]),
    );
    const explicitSources: ResolvedMarketplaceSources = [
      { kind: "clawhub", baseUrl: "https://explicit.example" },
    ] as unknown as ResolvedMarketplaceSources;

    await loadMarketplaceCatalog({
      localSkillsPath: localDir,
      sources: explicitSources,
      defaultClawhubBaseUrl: "https://clawhub.ai",
    });

    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch.mock.calls[0]![0]!.baseUrl).toBe(
      "https://explicit.example",
    );
  });

  it("C-03 does NOT inject when defaultClawhubBaseUrl is undefined", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "skills-c03-"));
    await loadMarketplaceCatalog({
      localSkillsPath: localDir,
      sources: [] as unknown as ResolvedMarketplaceSources,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it("C-04 synthetic source carries NO authToken", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "skills-c04-"));
    mockedFetch.mockResolvedValue(
      clawhubResp([{ name: "z", description: "z" }]),
    );
    await loadMarketplaceCatalog({
      localSkillsPath: localDir,
      sources: [] as unknown as ResolvedMarketplaceSources,
      defaultClawhubBaseUrl: "https://clawhub.ai",
    });
    const callArgs = mockedFetch.mock.calls[0]![0]!;
    expect(callArgs.authToken).toBeUndefined();
  });

  it("C-05 local wins on name collision against auto-injected ClawHub", async () => {
    const localDir = await mkdtemp(join(tmpdir(), "skills-c05-"));
    await makeLocalSkill(localDir, "frontend-design", "LOCAL");
    mockedFetch.mockResolvedValue(
      clawhubResp([{ name: "frontend-design", description: "REMOTE" }]),
    );
    const out = await loadMarketplaceCatalog({
      localSkillsPath: localDir,
      sources: [] as unknown as ResolvedMarketplaceSources,
      defaultClawhubBaseUrl: "https://clawhub.ai",
    });
    const fd = out.find((e) => e.name === "frontend-design")!;
    expect(fd).toBeDefined();
    expect(fd.source).toBe("local");
    expect(fd.description).toBe("LOCAL");
  });
});
