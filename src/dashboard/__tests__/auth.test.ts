/**
 * dashboard-rework P4 — admin auth gate. Server-side enforcement can't be
 * exercised through the read-only dev proxy (the live daemon has no auth), so
 * the gate logic is unit-tested here directly.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  isAdminAuthorized,
  isGatedRequest,
  tokensMatch,
  isAuthEnabled,
} from "../auth.js";

const ENV = "CLAWCODE_DASHBOARD_TOKEN";
afterEach(() => {
  delete process.env[ENV];
});

const req = (headers: Record<string, string>) => ({ headers });

describe("isGatedRequest", () => {
  it("gates mutating verbs", () => {
    expect(isGatedRequest("POST", "/api/agents/x/optimize")).toBe(true);
    expect(isGatedRequest("PUT", "/api/config/agents/x")).toBe(true);
    expect(isGatedRequest("DELETE", "/api/openai/keys/abc")).toBe(true);
    expect(isGatedRequest("POST", "/api/agents/x/restart")).toBe(true);
  });
  it("gates the OpenAI key surface even on GET", () => {
    expect(isGatedRequest("GET", "/api/openai/keys")).toBe(true);
  });
  it("does NOT gate read GETs, the telemetry sink, or the webhook", () => {
    expect(isGatedRequest("GET", "/api/status")).toBe(false);
    expect(isGatedRequest("GET", "/api/config/agents/x")).toBe(false);
    expect(isGatedRequest("POST", "/api/dashboard-telemetry")).toBe(false);
    expect(isGatedRequest("POST", "/webhook/abc")).toBe(false);
  });
});

describe("isAdminAuthorized", () => {
  it("FAILS OPEN when no token is configured (no lockout)", () => {
    expect(isAuthEnabled()).toBe(false);
    expect(isAdminAuthorized(req({}))).toBe(true);
  });
  it("requires a matching token when enabled", () => {
    process.env[ENV] = "s3cret-token";
    expect(isAuthEnabled()).toBe(true);
    expect(isAdminAuthorized(req({}))).toBe(false);
    expect(isAdminAuthorized(req({ authorization: "Bearer wrong" }))).toBe(false);
    expect(isAdminAuthorized(req({ authorization: "Bearer s3cret-token" }))).toBe(true);
    expect(isAdminAuthorized(req({ "x-clawcode-token": "s3cret-token" }))).toBe(true);
  });
  it("treats a blank/whitespace env token as disabled", () => {
    process.env[ENV] = "   ";
    expect(isAuthEnabled()).toBe(false);
    expect(isAdminAuthorized(req({}))).toBe(true);
  });
});

describe("tokensMatch (constant-time-ish)", () => {
  it("matches equal, rejects unequal and different-length", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });
});
