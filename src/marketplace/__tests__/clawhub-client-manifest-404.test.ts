/**
 * Phase 93 Plan 03 — ClawhubManifestNotFoundError tests (NF-01..NF-03).
 *
 * Pins the new 404 branch in downloadClawhubPluginManifest. Must coexist
 * with existing HUB-CLI-1..7 tests in clawhub-client.test.ts (no shared
 * state — separate file).
 *
 * Background: per RESEARCH §Pitfall 5, the ClawHub registry lists certain
 * plugins (e.g. hivemind as of 2026-04-24) without publishing a manifest at
 * any probed URL shape — every URL returns 404. Before this plan, the 404
 * fell through to the generic !res.ok branch and surfaced as a
 * misleading "manifest is invalid" error. We add a sibling error class
 * (NOT a subclass of ClawhubManifestInvalidError) so the install pipeline
 * can route 404s to a clearer manifest-unavailable outcome.
 */
import { describe, it, expect } from "vitest";
import {
  downloadClawhubPluginManifest,
  ClawhubManifestNotFoundError,
  ClawhubManifestInvalidError,
  ClawhubRateLimitedError,
  ClawhubAuthRequiredError,
} from "../clawhub-client.js";

function mockFetch(
  handler: (url: string, init?: RequestInit) => Response,
): typeof globalThis.fetch {
  return (async (input, init) =>
    handler(
      typeof input === "string" ? input : String(input),
      init,
    )) as typeof globalThis.fetch;
}

describe("downloadClawhubPluginManifest — Phase 93 Plan 03 NF-01..NF-03", () => {
  it("NF-01 throws ClawhubManifestNotFoundError on 404 with manifestUrl + status fields", async () => {
    const url = "https://clawhub.ai/api/v1/plugins/hivemind/manifest";
    const fetchFn = mockFetch(
      () => new Response("Not found", { status: 404, statusText: "Not Found" }),
    );

    await expect(
      downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: fetchFn },
      }),
    ).rejects.toThrow(ClawhubManifestNotFoundError);

    try {
      await downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: fetchFn },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClawhubManifestNotFoundError);
      const e = err as ClawhubManifestNotFoundError;
      expect(e.manifestUrl).toBe(url);
      expect(e.status).toBe(404);
      expect(e.message).toContain(url);
    }
  });

  it("NF-02 ClawhubManifestNotFoundError is a sibling (not subclass) of ClawhubManifestInvalidError", async () => {
    const url = "https://clawhub.ai/api/v1/plugins/foo/manifest";
    const fetchFn = mockFetch(
      () => new Response("", { status: 404, statusText: "Not Found" }),
    );
    try {
      await downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: fetchFn },
      });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ClawhubManifestNotFoundError);
      // Sibling, not subclass — operator UX must distinguish 404 from
      // malformed body (NF-02 protects against accidental subclassing).
      expect(err instanceof ClawhubManifestInvalidError).toBe(false);
      expect((err as Error).name).toBe("ClawhubManifestNotFoundError");
    }
  });

  it("NF-03 pre-existing 429/401/500 branches preserved (regression pin)", async () => {
    const url = "https://clawhub.ai/api/v1/plugins/x/manifest";

    // 429 → ClawhubRateLimitedError (NOT ClawhubManifestNotFoundError)
    const f429 = mockFetch(
      () =>
        new Response("", {
          status: 429,
          headers: { "Retry-After": "2" },
        }),
    );
    await expect(
      downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: f429 },
      }),
    ).rejects.toBeInstanceOf(ClawhubRateLimitedError);

    // 401 → ClawhubAuthRequiredError
    const f401 = mockFetch(
      () => new Response("", { status: 401, statusText: "Unauthorized" }),
    );
    await expect(
      downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: f401 },
      }),
    ).rejects.toBeInstanceOf(ClawhubAuthRequiredError);

    // 500 → generic Error (NOT NotFound, NOT Invalid)
    const f500 = mockFetch(
      () =>
        new Response("Internal Server Error", {
          status: 500,
          statusText: "Internal Server Error",
        }),
    );
    await expect(
      downloadClawhubPluginManifest({
        manifestUrl: url,
        deps: { fetch: f500 },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("500"),
    });
  });
});
