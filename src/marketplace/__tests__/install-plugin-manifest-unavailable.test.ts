/**
 * Phase 93 Plan 03 — mapFetchErrorToOutcome manifest-unavailable mapping
 * tests (MU-01..MU-04).
 *
 * Pins:
 *   MU-01 — ClawhubManifestNotFoundError → manifest-unavailable outcome
 *           with manifestUrl + status carried through.
 *   MU-02 — Outcome is frozen (Object.freeze regression — matches existing
 *           manifest-invalid / auth-required / rate-limited shape).
 *   MU-03 — Exhaustive switch invariant (compile-time + runtime): the new
 *           variant is assignable to PluginInstallOutcome and the never
 *           sample branch type-checks. If a future contributor adds a
 *           variant without a case, this fails to compile.
 *   MU-04 — Pre-existing branches preserved: ClawhubManifestInvalidError
 *           still maps to manifest-invalid; unknown errors still fall
 *           through to manifest-invalid (regression pin).
 */
import { describe, it, expect } from "vitest";
import {
  mapFetchErrorToOutcome,
  type PluginInstallOutcome,
} from "../install-plugin.js";
import {
  ClawhubManifestNotFoundError,
  ClawhubManifestInvalidError,
} from "../clawhub-client.js";

describe("mapFetchErrorToOutcome — Phase 93 Plan 03 manifest-unavailable", () => {
  it("MU-01 routes ClawhubManifestNotFoundError → manifest-unavailable with payload", () => {
    const url = "https://clawhub.ai/api/v1/plugins/hivemind/manifest";
    const err = new ClawhubManifestNotFoundError(
      url,
      404,
      `clawhub plugin manifest: 404 Not Found at ${url}`,
    );
    const outcome = mapFetchErrorToOutcome(err, "hivemind");
    expect(outcome.kind).toBe("manifest-unavailable");
    if (outcome.kind === "manifest-unavailable") {
      expect(outcome.plugin).toBe("hivemind");
      expect(outcome.manifestUrl).toBe(url);
      expect(outcome.status).toBe(404);
    }
  });

  it("MU-02 outcome is frozen (matches existing manifest-invalid/auth-required/rate-limited pattern)", () => {
    const err = new ClawhubManifestNotFoundError("https://x/y", 404, "404");
    const outcome = mapFetchErrorToOutcome(err, "p");
    expect(Object.isFrozen(outcome)).toBe(true);
  });

  it("MU-03 union narrowing — manifest-unavailable variant exhaustively assignable", () => {
    const err = new ClawhubManifestNotFoundError("https://x/y", 404, "404");
    const outcome: PluginInstallOutcome = mapFetchErrorToOutcome(err, "p");
    // Compile-time exhaustive switch (tsc enforces this) + runtime sentinel.
    let touched = false;
    switch (outcome.kind) {
      case "installed":
      case "installed-persist-failed":
      case "already-installed":
      case "blocked-secret-scan":
      case "manifest-invalid":
      case "config-missing":
      case "auth-required":
      case "rate-limited":
      case "not-in-catalog":
        break;
      case "manifest-unavailable":
        touched = true;
        break;
      default: {
        const _exhaustive: never = outcome;
        void _exhaustive;
      }
    }
    expect(touched).toBe(true);
  });

  it("MU-04 pre-existing branches preserved (regression pin)", () => {
    // ClawhubManifestInvalidError → manifest-invalid (NOT manifest-unavailable)
    const invalid = new ClawhubManifestInvalidError(
      "missing required name/command",
    );
    const o1 = mapFetchErrorToOutcome(invalid, "x");
    expect(o1.kind).toBe("manifest-invalid");

    // Unknown / generic Error → manifest-invalid fallthrough (existing behavior)
    const generic = new Error("network unreachable");
    const o2 = mapFetchErrorToOutcome(generic, "x");
    expect(o2.kind).toBe("manifest-invalid");
  });
});
