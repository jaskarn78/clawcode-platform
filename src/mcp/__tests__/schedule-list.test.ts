/**
 * 999.174 — `list_schedules` must show the recurring schedules an agent created
 * with `schedule_recurring`. Fixture = client-a-personal's two "phantom" price-watch
 * schedules as they sat in the live store on 2026-09-24.
 */
import { describe, it, expect } from "vitest";
import { renderScheduleList } from "../schedule-list.js";

const CONFIG = [
  { agentName: "shopping", name: "price-watch", cron: "30 9,18 * * *", enabled: true, nextRun: "2026-09-24T18:30:00.000Z" },
];
const RECURRING = [
  { scheduleId: "wBjToBxI", agentName: "client-a-personal", cron: "15 7 * * *", prompt: "Run the daily price watch:\n  python3 shopping/watch.py and report any alert." },
  { scheduleId: "Pq_nZU9t", agentName: "client-a-personal", cron: "15 12 20-30 11 *", prompt: "Black Friday window check" },
];

describe("renderScheduleList", () => {
  it("shows recurring schedules the daemon returns (the 'phantom' schedules)", () => {
    const text = renderScheduleList({ schedules: CONFIG, recurring: RECURRING });
    expect(text).toContain("shopping/price-watch: 30 9,18 * * * (enabled)");
    expect(text).toMatch(/^client-a-personal\/recurring:wBjToBxI: 15 7 \* \* \* — Run the daily price watch: python3 shopping\/watch\.py .{1,10}…$/m);
    expect(text).toContain("client-a-personal/recurring:Pq_nZU9t: 15 12 20-30 11 * — Black Friday window check");
  });

  it("recurring-only is not 'No scheduled tasks'", () => {
    expect(renderScheduleList({ schedules: [], recurring: RECURRING })).toContain("recurring:wBjToBxI");
  });

  it("keeps the old output for config-only results and pre-999.99 daemons", () => {
    expect(renderScheduleList({ schedules: CONFIG })).toBe(
      "shopping/price-watch: 30 9,18 * * * (enabled) next: 2026-09-24T18:30:00.000Z",
    );
    expect(renderScheduleList({ schedules: [] })).toBe("No scheduled tasks");
    expect(renderScheduleList({ schedules: [], recurring: [] })).toBe("No scheduled tasks");
  });
});
