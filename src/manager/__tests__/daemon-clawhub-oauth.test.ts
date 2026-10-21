/**
 * Phase 90 Plan 06 HUB-07 — Daemon IPC handlers for OAuth + op-probe.
 *
 * Pins:
 *   IPC-CLH-1       handleClawhubOauthStartIpc returns {user_code,
 *                   verification_uri, device_code, poll_interval_s, expires_at}
 *   IPC-CLH-2       handleClawhubOauthPollIpc with success writes to 1P +
 *                   returns {stored:true, ...}
 *   IPC-CLH-3       handleClawhubOauthPollIpc with OAuthExpiredError returns
 *                   {stored:false, message:/expired/}
 *   IPC-PROBE-1     handleMarketplaceProbeOpItemsIpc returns proposal when
 *                   fuzzy match exists
 *   IPC-PROBE-2     returns {proposal:null} when no match
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Logger } from "pino";
import * as githubOauthMod from "../../marketplace/github-oauth.js";
import * as opRewriteMod from "../../marketplace/op-rewrite.js";
import {
  handleClawhubOauthStartIpc,
  handleClawhubOauthPollIpc,
  handleMarketplaceProbeOpItemsIpc,
} from "../daemon.js";

function stubLog(): Logger {
  const fn = vi.fn();
  const stub = {
    info: fn,
    warn: fn,
    error: fn,
    debug: fn,
    trace: fn,
    fatal: fn,
    child: vi.fn(),
  };
  stub.child.mockReturnValue(stub);
  return stub as unknown as Logger;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("handleClawhubOauthStartIpc (IPC-CLH-1)", () => {
  it("IPC-CLH-1: returns device-code payload", async () => {
    const spy = vi
      .spyOn(githubOauthMod, "initiateDeviceCodeFlow")
      .mockResolvedValue(
        Object.freeze({
          user_code: "ABCD-EFGH",
          verification_uri: "https://github.com/login/device",
          device_code: "dev-1",
          interval: 5,
          expires_at: 1_000_000,
        }),
      );
    const result = await handleClawhubOauthStartIpc({ log: stubLog() }, {});
    expect(result.user_code).toBe("ABCD-EFGH");
    expect(result.verification_uri).toBe("https://github.com/login/device");
    expect(result.device_code).toBe("dev-1");
    expect(result.poll_interval_s).toBe(5);
    expect(result.expires_at).toBe(1_000_000);
    spy.mockRestore();
  });
});

describe("handleClawhubOauthPollIpc (IPC-CLH-2, IPC-CLH-3)", () => {
  it("IPC-CLH-2: success → stores in 1P, returns stored:true", async () => {
    const pollSpy = vi
      .spyOn(githubOauthMod, "pollForAccessToken")
      .mockResolvedValue("gho_xyz");
    const storeSpy = vi
      .spyOn(githubOauthMod, "storeTokenTo1Password")
      .mockResolvedValue(undefined);
    const result = await handleClawhubOauthPollIpc(
      { log: stubLog() },
      {
        device_code: "dev-1",
        poll_interval_s: 5,
        expires_at: Date.now() + 900_000,
      },
    );
    expect(result.stored).toBe(true);
    expect(result.message).toMatch(/op:\/\/example-vault-21\/ClawHub Token/);
    expect(storeSpy).toHaveBeenCalledWith("gho_xyz", expect.any(String));
    pollSpy.mockRestore();
    storeSpy.mockRestore();
  });

  it("IPC-CLH-3: OAuthExpiredError → stored:false, message:/expired/", async () => {
    const pollSpy = vi
      .spyOn(githubOauthMod, "pollForAccessToken")
      .mockRejectedValue(new githubOauthMod.OAuthExpiredError());
    const result = await handleClawhubOauthPollIpc(
      { log: stubLog() },
      {
        device_code: "dev-1",
        poll_interval_s: 5,
        expires_at: Date.now() + 900_000,
      },
    );
    expect(result.stored).toBe(false);
    expect(result.message).toMatch(/expired/i);
    pollSpy.mockRestore();
  });

  it("throws on missing device_code param", async () => {
    await expect(
      handleClawhubOauthPollIpc({ log: stubLog() }, {}),
    ).rejects.toThrow(/device_code/i);
  });
});

describe("handleMarketplaceProbeOpItemsIpc (IPC-PROBE-1, IPC-PROBE-2)", () => {
  it("IPC-PROBE-1: returns proposal when fuzzy match found", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(
        Object.freeze([
          Object.freeze({
            uuid: "u-1",
            title: "MySQL DB - Unraid",
            category: "Credential",
          }),
        ]),
      );
    const result = await handleMarketplaceProbeOpItemsIpc(
      { log: stubLog() },
      { fieldName: "DB_PASSWORD", fieldLabel: "MySQL Password" },
    );
    expect(result.proposal).not.toBeNull();
    expect(result.proposal?.uri).toBe(
      "op://example-vault-21/MySQL DB - Unraid/password",
    );
    listSpy.mockRestore();
  });

  it("IPC-PROBE-2: returns proposal:null when no match", async () => {
    const listSpy = vi
      .spyOn(opRewriteMod, "listOpItems")
      .mockResolvedValue(Object.freeze([]));
    const result = await handleMarketplaceProbeOpItemsIpc(
      { log: stubLog() },
      { fieldName: "CRYPTIC_XYZ", fieldLabel: "Cryptic XYZ" },
    );
    expect(result.proposal).toBeNull();
    listSpy.mockRestore();
  });

  it("throws on missing fieldName param", async () => {
    await expect(
      handleMarketplaceProbeOpItemsIpc({ log: stubLog() }, {}),
    ).rejects.toThrow(/fieldName/i);
  });
});
