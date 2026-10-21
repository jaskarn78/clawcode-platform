/**
 * Phase 138 Plan 03 T-02 — static-grep wire-format regression.
 *
 * Pins the FOUR verbatim `ALERT_MSG_*` constants in `alert-messages.ts`
 * byte-for-byte. Any future edit that drifts the operator-visible
 * Discord alert format — an emoji swap, an indentation change, a
 * placeholder rename, a reworded action sub-line — fails this test.
 * The operator must then explicitly bump the assertions below to
 * ratify the wire-format change, exactly the way Phase 137-02 / 999.58
 * gated their wire-format constants.
 *
 * This is a SOURCE-TEXT test (it reads the .ts file), not a behavioral
 * test — it deliberately couples to the string-concatenation form used
 * in `alert-messages.ts`. If localisation ever requires the format to
 * vary, this test moves up a level (assert STRUCTURE not VERBATIM); for
 * Phase 138 it ships strict-verbatim.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

describe("alert-messages.ts wire-format regression (static grep)", () => {
  const src = readFileSync(
    join(__dirname, "..", "alert-messages.ts"),
    "utf8",
  );

  it("contains ALERT_MSG_75 verbatim", () => {
    expect(src).toContain('"⚠️ {provider} usage at 75% (${cost_usd}/${cap_usd})\\n"');
    expect(src).toContain('"Triggered: {timestamp}\\n"');
    expect(src).toContain('"Agents affected: {agents}\\n"');
    expect(src).toContain('"Action: manual review"');
  });

  it("contains ALERT_MSG_90 verbatim", () => {
    expect(src).toContain('"⚠️ {provider} usage at 90% (${cost_usd}/${cap_usd})\\n"');
  });

  it("contains ALERT_MSG_95 verbatim", () => {
    expect(src).toContain('"🚨 {provider} usage at 95% (${cost_usd}/${cap_usd})\\n"');
    expect(src).toContain('"Action: failover {failover_summary}"');
  });

  it("contains ALERT_MSG_99 verbatim", () => {
    expect(src).toContain('"🛑 {provider} usage at 99% (${cost_usd}/${cap_usd})\\n"');
    expect(src).toContain(
      '"Action: hard cap soon — operator action required"',
    );
  });

  it("declares all four constants by name", () => {
    expect(src).toContain("export const ALERT_MSG_75 =");
    expect(src).toContain("export const ALERT_MSG_90 =");
    expect(src).toContain("export const ALERT_MSG_95 =");
    expect(src).toContain("export const ALERT_MSG_99 =");
  });

  it("pins the THRESHOLDS tuple verbatim", () => {
    expect(src).toContain("export const THRESHOLDS = [75, 90, 95, 99] as const;");
  });
});
