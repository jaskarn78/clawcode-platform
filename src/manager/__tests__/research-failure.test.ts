import { describe, expect, it } from "vitest";
import { classifyFailure, failureNotice, parseResetTime, topReason } from "../research-failure.js";

const PROD_SUMMARY =
  "Agent terminated early due to an API error: You've hit your session limit · resets 5:30pm (America/Los_Angeles) (error type rate_limit, HTTP 429 req_011CUabc)";

describe("research failure reasons (999.173 polish)", () => {
  it("parses the reset time from the prod error text", () => {
    expect(parseResetTime(PROD_SUMMARY)).toBe("5:30 PM PT");
    expect(parseResetTime("resets 9am (America/New_York)")).toBe("9:00 AM ET");
    expect(parseResetTime("resets at 11:15 p.m.")).toBe("11:15 PM");
    expect(parseResetTime("no time here")).toBeUndefined();
    expect(parseResetTime("resets 25pm")).toBeUndefined();
  });

  it("classifies: usage limit (with reset), API error, stopped, unknown — never the raw text", () => {
    const usage = classifyFailure("failed", PROD_SUMMARY);
    expect(usage).toEqual({ code: "usage-limit", text: "usage limit reached, resets 5:30 PM PT", resetsAt: "5:30 PM PT" });
    expect(classifyFailure("failed", "Agent terminated early due to an API error: overloaded_error").code).toBe("api-error");
    expect(classifyFailure("stopped", "anything")).toEqual({ code: "stopped", text: "stopped by user" });
    expect(classifyFailure("failed", "weird")).toEqual({ code: "failed", text: "failed" });
    for (const r of [usage, classifyFailure("failed", "HTTP 503 api_error")]) expect(r.text).not.toMatch(/HTTP|429|req_|rate_limit/);
  });

  it("picks the most significant reason and words the daemon's notice", () => {
    const usage = classifyFailure("failed", PROD_SUMMARY);
    expect(topReason([classifyFailure("stopped", ""), usage, null])).toBe(usage);
    expect(failureNotice(usage)).toBe(
      "Research couldn't run: the Claude usage limit is reached until 5:30 PM PT. Ask again after that.",
    );
    expect(failureNotice(classifyFailure("failed", "rate_limit"))).toBe(
      "Research couldn't run: the Claude usage limit is reached. Ask again later.",
    );
    expect(failureNotice(classifyFailure("stopped", ""))).toBeNull();
    expect(failureNotice(null)).toBeNull();
  });
});
