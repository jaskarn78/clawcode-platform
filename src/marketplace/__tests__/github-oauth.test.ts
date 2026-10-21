/**
 * Phase 90 Plan 06 HUB-07 — GitHub OAuth device-code flow tests.
 *
 * Pins (GH-D1..D5, GH-ST1):
 *   GH-D1  initiateDeviceCodeFlow — valid response parses to DeviceCodeInit
 *   GH-D2  pollForAccessToken success on first poll
 *   GH-D3  pollForAccessToken pending → success
 *   GH-D4  pollForAccessToken slow_down bumps interval by +5s
 *   GH-D5  pollForAccessToken expired_token → OAuthExpiredError
 *   GH-ST1 storeTokenTo1Password invokes `op item create` with correct shape
 */
import { describe, it, expect, vi } from "vitest";
import {
  initiateDeviceCodeFlow,
  pollForAccessToken,
  storeTokenTo1Password,
  OAuthExpiredError,
  OAuthAccessDeniedError,
} from "../github-oauth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  } as Response;
}

describe("initiateDeviceCodeFlow (GH-D1)", () => {
  it("GH-D1: parses valid device-code response", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({
        device_code: "dev-123",
        user_code: "WDJB-MJHT",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      }),
    );
    const now = 1_000_000;
    const init = await initiateDeviceCodeFlow({
      fetch: fetchStub as never,
      now: () => now,
    });
    expect(init.user_code).toBe("WDJB-MJHT");
    expect(init.verification_uri).toBe("https://github.com/login/device");
    expect(init.device_code).toBe("dev-123");
    expect(init.interval).toBe(5);
    expect(init.expires_at).toBe(now + 900 * 1000);

    // Verify request shape
    const [url, init0] = fetchStub.mock.calls[0];
    expect(url).toBe("https://github.com/login/device/code");
    const initAny = init0 as { method?: string; body?: string };
    expect(initAny.method).toBe("POST");
    expect(initAny.body).toContain("client_id=");
  });

  it("throws when GitHub returns non-OK", async () => {
    const fetchStub = vi.fn().mockResolvedValue(jsonResponse({}, 500));
    await expect(
      initiateDeviceCodeFlow({ fetch: fetchStub as never }),
    ).rejects.toThrow(/device-code init failed/);
  });
});

describe("pollForAccessToken (GH-D2..D5)", () => {
  const baseInit = Object.freeze({
    user_code: "WDJB-MJHT",
    verification_uri: "https://github.com/login/device",
    device_code: "dev-123",
    interval: 1,
    expires_at: 1_000_000_000 + 900 * 1000,
  });

  it("GH-D2: returns access_token on first successful poll", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({ access_token: "gho_xyz", token_type: "bearer" }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = 1_000_000_000;
    const token = await pollForAccessToken(baseInit, {
      fetch: fetchStub as never,
      sleep,
      now: () => t,
    });
    expect(token).toBe("gho_xyz");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("GH-D3: authorization_pending → access_token", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "authorization_pending" }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "gho_ok", token_type: "bearer" }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForAccessToken(baseInit, {
      fetch: fetchStub as never,
      sleep,
      now: () => 1_000_000_000,
    });
    expect(token).toBe("gho_ok");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("GH-D4: slow_down bumps interval by +5s", async () => {
    const fetchStub = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "slow_down" }))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "gho_slow", token_type: "bearer" }),
      );
    const sleep = vi.fn().mockResolvedValue(undefined);
    const token = await pollForAccessToken(baseInit, {
      fetch: fetchStub as never,
      sleep,
      now: () => 1_000_000_000,
    });
    expect(token).toBe("gho_slow");
    // First sleep uses baseInit.interval (1s → 1000ms)
    // Second sleep is bumped by +5s → 6000ms
    const sleepArgs = sleep.mock.calls.map((c) => c[0]);
    expect(sleepArgs[0]).toBe(1000);
    expect(sleepArgs[1]).toBe(6000);
  });

  it("GH-D5: expired_token throws OAuthExpiredError", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({ error: "expired_token" }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      pollForAccessToken(baseInit, {
        fetch: fetchStub as never,
        sleep,
        now: () => 1_000_000_000,
      }),
    ).rejects.toThrow(OAuthExpiredError);
  });

  it("access_denied throws OAuthAccessDeniedError", async () => {
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({ error: "access_denied" }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(
      pollForAccessToken(baseInit, {
        fetch: fetchStub as never,
        sleep,
        now: () => 1_000_000_000,
      }),
    ).rejects.toThrow(OAuthAccessDeniedError);
  });

  it("expires when clock passes expires_at", async () => {
    // Use a clock that starts after expires_at so the while-loop exits
    // without any successful poll.
    const fetchStub = vi.fn().mockResolvedValue(
      jsonResponse({ error: "authorization_pending" }),
    );
    const sleep = vi.fn().mockResolvedValue(undefined);
    let t = baseInit.expires_at + 1;
    await expect(
      pollForAccessToken(baseInit, {
        fetch: fetchStub as never,
        sleep,
        now: () => t,
      }),
    ).rejects.toThrow(OAuthExpiredError);
  });
});

describe("storeTokenTo1Password (GH-ST1)", () => {
  it("GH-ST1: invokes `op item create` with credential field", async () => {
    const runStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await storeTokenTo1Password("gho_xyz", "ClawHub Token", {
      run: runStub as never,
    });
    expect(runStub).toHaveBeenCalledTimes(1);
    const [bin, args] = runStub.mock.calls[0];
    expect(bin).toBe("op");
    expect(args).toContain("item");
    expect(args).toContain("create");
    expect(args).toContain("--category=Credential");
    expect((args as string[]).some((a) => a.includes("ClawHub Token"))).toBe(
      true,
    );
    expect((args as string[]).some((a) => a.includes("gho_xyz"))).toBe(true);
  });

  it("uses default label 'ClawHub Token' when omitted", async () => {
    const runStub = vi.fn().mockResolvedValue({ stdout: "", stderr: "" });
    await storeTokenTo1Password("gho_abc", undefined, {
      run: runStub as never,
    });
    const args = runStub.mock.calls[0][1] as string[];
    expect(args.some((a) => a.includes("ClawHub Token"))).toBe(true);
  });
});
