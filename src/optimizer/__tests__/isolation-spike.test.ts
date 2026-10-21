/**
 * Phase 142 — isolation-spike CLASSIFIER tests.
 *
 * These test the verdict logic only. The spike's real value is the LIVE run
 * (runIsolationSpike against a real SessionManager) — see ISOLATION-SPIKE.md.
 */
import { describe, it, expect } from "vitest";
import { classifyIsolation, SENTINEL_NAME, SENTINEL_PHRASE } from "../isolation-spike.js";

describe("Phase 142 — classifyIsolation", () => {
  it("ISOLATED when the sentinel is present and no live skill leaks", () => {
    const r = classifyIsolation(
      `My skills:\n- ${SENTINEL_NAME}\n${SENTINEL_PHRASE}`,
      ["reelforge", "market-research"],
    );
    expect(r.verdict).toBe("ISOLATED");
    expect(r.sentinelLoaded).toBe(true);
    expect(r.liveSkillsLeaked).toEqual([]);
  });

  it("LEAKED when a live skill name appears (even if the sentinel is also present)", () => {
    const r = classifyIsolation(
      `My skills:\n- ${SENTINEL_NAME}\n- market-research\n${SENTINEL_PHRASE}`,
      ["market-research"],
    );
    expect(r.verdict).toBe("LEAKED");
    expect(r.liveSkillsLeaked).toEqual(["market-research"]);
  });

  it("INCONCLUSIVE when neither the sentinel nor any live skill appears", () => {
    const r = classifyIsolation("I'm not sure which skills I have.", ["market-research"]);
    expect(r.verdict).toBe("INCONCLUSIVE");
    expect(r.sentinelLoaded).toBe(false);
  });

  it("ignores empty live-skill names when checking for leaks", () => {
    const r = classifyIsolation(`${SENTINEL_PHRASE}`, [""]);
    expect(r.verdict).toBe("ISOLATED");
    expect(r.liveSkillsLeaked).toEqual([]);
  });
});
