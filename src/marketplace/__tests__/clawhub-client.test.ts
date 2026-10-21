/**
 * Phase 90 Plan 04 Task 1 — clawhub-client.ts HTTP primitives tests.
 *
 * Pins behavior per 90-04-PLAN (HUB-CLI-1..7):
 *   HUB-CLI-1  fetchClawhubSkills happy path — resolves items + nextCursor;
 *              URL is `<baseUrl>/api/v1/skills?q=<encoded>`.
 *   HUB-CLI-2  authToken → Authorization: Bearer <token> header set.
 *   HUB-CLI-3  User-Agent header present on every request.
 *   HUB-CLI-4  429 → throws ClawhubRateLimitedError with Retry-After * 1000.
 *   HUB-CLI-5  401/403 → throws ClawhubAuthRequiredError.
 *   HUB-CLI-6  cursor → `?cursor=<opaque>`, combines with query →
 *              `?q=foo&cursor=abc`.
 *   HUB-CLI-7  downloadClawhubSkill → writes skill.tar.gz to stagingDir,
 *              extracts via `tar -xzf`, returns {extractedDir, files}.
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import {
  fetchClawhubSkills,
  downloadClawhubSkill,
  fetchClawhubPlugins,
  downloadClawhubPluginManifest,
  ClawhubRateLimitedError,
  ClawhubAuthRequiredError,
  ClawhubManifestInvalidError,
} from "../clawhub-client.js";

// ---------------------------------------------------------------------------
// DI'd fetch mock helper — returns a controllable Response.
// ---------------------------------------------------------------------------

type MockFetchCall = {
  url: string;
  init?: RequestInit;
};

function makeMockFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
): { fetch: typeof globalThis.fetch; calls: MockFetchCall[] } {
  const calls: MockFetchCall[] = [];
  const fetchFn: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    return handler(url, init);
  };
  return { fetch: fetchFn, calls };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("fetchClawhubSkills — Phase 90 Plan 04 (HUB-CLI-1..6)", () => {
  it("HUB-CLI-1: happy path — returns {items, nextCursor}; URL includes /api/v1/skills?q=frontend", async () => {
    const mockBody = {
      items: [
        {
          id: "abc",
          name: "frontend-design",
          description: "fleet design skill",
          version: "1.0.0",
          author: "user",
          downloadUrl: "https://clawhub.ai/skills/frontend-design-1.0.0.tar.gz",
        },
      ],
      nextCursor: null,
    };
    const { fetch, calls } = makeMockFetch(() => jsonResponse(mockBody));

    const result = await fetchClawhubSkills({
      baseUrl: "http://localhost/mock",
      query: "frontend",
      deps: { fetch },
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe("frontend-design");
    expect(result.nextCursor).toBeNull();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://localhost/mock/api/v1/skills?q=frontend");
  });

  it("HUB-CLI-2: authToken → Authorization: Bearer <token> header", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse({ items: [], nextCursor: null }),
    );

    await fetchClawhubSkills({
      baseUrl: "https://clawhub.ai",
      authToken: "gho_abc",
      deps: { fetch },
    });

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer gho_abc");
  });

  it("HUB-CLI-3: User-Agent header matches ClawCode/<version> (clawcode-marketplace)", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse({ items: [], nextCursor: null }),
    );

    await fetchClawhubSkills({
      baseUrl: "https://clawhub.ai",
      deps: { fetch },
    });

    expect(calls).toHaveLength(1);
    const headers = new Headers(calls[0].init?.headers as HeadersInit);
    const ua = headers.get("User-Agent");
    expect(ua).toMatch(/^ClawCode\/[0-9]+\.[0-9]+\.[0-9]+ \(clawcode-marketplace\)$/);
  });

  it("HUB-CLI-4: 429 → throws ClawhubRateLimitedError with retryAfterMs = Retry-After * 1000", async () => {
    const { fetch } = makeMockFetch(() =>
      new Response("rate-limited", {
        status: 429,
        headers: { "Retry-After": "120" },
      }),
    );

    let caught: unknown;
    try {
      await fetchClawhubSkills({
        baseUrl: "https://clawhub.ai",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubRateLimitedError);
    if (caught instanceof ClawhubRateLimitedError) {
      expect(caught.retryAfterMs).toBe(120_000);
    }
  });

  it("HUB-CLI-5: 401 → throws ClawhubAuthRequiredError; 403 also → ClawhubAuthRequiredError", async () => {
    for (const status of [401, 403]) {
      const { fetch } = makeMockFetch(() =>
        new Response("denied", { status }),
      );
      let caught: unknown;
      try {
        await fetchClawhubSkills({
          baseUrl: "https://clawhub.ai",
          deps: { fetch },
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ClawhubAuthRequiredError);
    }
  });

  it("HUB-CLI-6: cursor only → ?cursor=abc; combined with q → ?q=foo&cursor=abc", async () => {
    const { fetch, calls } = makeMockFetch(() =>
      jsonResponse({ items: [], nextCursor: null }),
    );

    await fetchClawhubSkills({
      baseUrl: "https://clawhub.ai",
      cursor: "abc",
      deps: { fetch },
    });
    expect(calls[0].url).toBe("https://clawhub.ai/api/v1/skills?cursor=abc");

    await fetchClawhubSkills({
      baseUrl: "https://clawhub.ai",
      query: "foo",
      cursor: "abc",
      deps: { fetch },
    });
    // URLSearchParams preserves insertion order; q first then cursor.
    expect(calls[1].url).toBe("https://clawhub.ai/api/v1/skills?q=foo&cursor=abc");
  });

  it("HUB-CLI-MANIFEST: malformed body (no items[]) → throws ClawhubManifestInvalidError", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse({ notItems: "garbage" }),
    );
    let caught: unknown;
    try {
      await fetchClawhubSkills({
        baseUrl: "https://clawhub.ai",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubManifestInvalidError);
  });
});

describe("downloadClawhubSkill — Phase 90 Plan 04 (HUB-CLI-7)", () => {
  it("HUB-CLI-7: writes skill.tar.gz, extracts via tar -xzf, returns {extractedDir, files}", async () => {
    // Build a real tarball with a tiny SKILL.md so the extraction round-trips.
    const fixtureRoot = await mkdtemp(join(tmpdir(), "clawhub-fx-"));
    try {
      const skillSource = join(fixtureRoot, "src", "my-skill");
      await mkdir(skillSource, { recursive: true });
      await writeFile(
        join(skillSource, "SKILL.md"),
        "---\nname: my-skill\ndescription: fixture\n---\n",
        "utf8",
      );
      const tarPath = join(fixtureRoot, "fixture.tar.gz");
      await execFileP("tar", [
        "-czf",
        tarPath,
        "-C",
        join(fixtureRoot, "src"),
        "my-skill",
      ]);
      const tarBytes = await readFile(tarPath);

      const { fetch } = makeMockFetch(async (url) => {
        if (url === "https://example.com/skill.tar.gz") {
          return new Response(tarBytes, {
            status: 200,
            headers: { "content-type": "application/gzip" },
          });
        }
        return new Response("not found", { status: 404 });
      });

      const stagingDir = join(fixtureRoot, "staging");
      const result = await downloadClawhubSkill({
        downloadUrl: "https://example.com/skill.tar.gz",
        stagingDir,
        deps: { fetch },
      });

      expect(existsSync(join(stagingDir, "skill.tar.gz"))).toBe(true);
      expect(result.extractedDir).toBe(join(stagingDir, "extracted"));
      expect(existsSync(join(result.extractedDir, "my-skill", "SKILL.md"))).toBe(
        true,
      );
      // At least one file found by walker.
      expect(result.files.length).toBeGreaterThan(0);
      expect(
        result.files.some((f) => f.endsWith("my-skill/SKILL.md")),
      ).toBe(true);
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("downloadClawhubSkill: 429 → ClawhubRateLimitedError with Retry-After", async () => {
    const { fetch } = makeMockFetch(() =>
      new Response("", {
        status: 429,
        headers: { "Retry-After": "30" },
      }),
    );
    let caught: unknown;
    try {
      await downloadClawhubSkill({
        downloadUrl: "https://example.com/x.tar.gz",
        stagingDir: await mkdtemp(join(tmpdir(), "clawhub-dl-")),
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubRateLimitedError);
    if (caught instanceof ClawhubRateLimitedError) {
      expect(caught.retryAfterMs).toBe(30_000);
    }
  });

  it("downloadClawhubSkill: 401 → ClawhubAuthRequiredError", async () => {
    const { fetch } = makeMockFetch(() =>
      new Response("", { status: 401 }),
    );
    let caught: unknown;
    try {
      await downloadClawhubSkill({
        downloadUrl: "https://example.com/x.tar.gz",
        stagingDir: await mkdtemp(join(tmpdir(), "clawhub-dl-")),
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubAuthRequiredError);
  });
});

// ---------------------------------------------------------------------------
// Phase 90 Plan 05 HUB-02 — fetchClawhubPlugins + downloadClawhubPluginManifest
// ---------------------------------------------------------------------------

describe("fetchClawhubPlugins — Phase 90 Plan 05 (PL-C1-fetch)", () => {
  it("PL-C1-fetch: happy path — returns {items, nextCursor}; URL includes /api/v1/plugins", async () => {
    const mockBody = {
      items: [
        {
          name: "acme-db-helper",
          latestVersion: "1.2.0",
          displayName: "Acme DB",
          summary: "MySQL helper",
          runtimeId: "acme-db-helper",
          ownerHandle: "acme",
          family: "code-plugin",
        },
      ],
      nextCursor: null,
    };
    const { fetch, calls } = makeMockFetch(() => jsonResponse(mockBody));
    const result = await fetchClawhubPlugins({
      baseUrl: "http://localhost/mock",
      query: "mysql",
      deps: { fetch },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      "http://localhost/mock/api/v1/plugins?q=mysql",
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.name).toBe("acme-db-helper");
    expect(result.nextCursor).toBeNull();
  });

  it("fetchClawhubPlugins: 429 → ClawhubRateLimitedError with Retry-After * 1000", async () => {
    const { fetch } = makeMockFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "Retry-After": "30" },
        }),
    );
    let caught: unknown;
    try {
      await fetchClawhubPlugins({
        baseUrl: "http://localhost/mock",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubRateLimitedError);
    if (caught instanceof ClawhubRateLimitedError) {
      expect(caught.retryAfterMs).toBe(30_000);
    }
  });

  it("fetchClawhubPlugins: malformed response → ClawhubManifestInvalidError", async () => {
    const { fetch } = makeMockFetch(() => jsonResponse({ not_items: 1 }));
    let caught: unknown;
    try {
      await fetchClawhubPlugins({
        baseUrl: "http://localhost/mock",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubManifestInvalidError);
  });
});

describe("downloadClawhubPluginManifest — Phase 90 Plan 05 (PL-C4-fetch)", () => {
  it("PL-C4-fetch: returns normalized manifest with defaulted optional fields", async () => {
    const manifest = {
      name: "test-plugin",
      command: "mcporter",
      // description/version/args omitted — client defaults
    };
    const { fetch } = makeMockFetch(() => jsonResponse(manifest));
    const result = await downloadClawhubPluginManifest({
      manifestUrl: "https://clawhub.ai/api/v1/plugins/test/manifest",
      deps: { fetch },
    });
    expect(result.name).toBe("test-plugin");
    expect(result.command).toBe("mcporter");
    expect(result.description).toBe("");
    expect(result.version).toBe("0.0.0");
    expect(result.args).toEqual([]);
  });

  it("downloadClawhubPluginManifest: missing command → ClawhubManifestInvalidError", async () => {
    const { fetch } = makeMockFetch(() =>
      jsonResponse({ name: "test-plugin" }), // no command
    );
    let caught: unknown;
    try {
      await downloadClawhubPluginManifest({
        manifestUrl: "https://clawhub.ai/manifest",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubManifestInvalidError);
  });

  it("downloadClawhubPluginManifest: 401 → ClawhubAuthRequiredError", async () => {
    const { fetch } = makeMockFetch(() =>
      new Response("", { status: 401 }),
    );
    let caught: unknown;
    try {
      await downloadClawhubPluginManifest({
        manifestUrl: "https://clawhub.ai/manifest",
        deps: { fetch },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ClawhubAuthRequiredError);
  });
});
