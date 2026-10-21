/**
 * Phase 999.176 — IPC surface for the fleet account swap. Deliberately
 * tiny: a redacted status read and code submission. Starting a login or a
 * swap is only reachable from the admin-gated `/clawcode-account` flow.
 */

import { z } from "zod";
import type { AccountService } from "./account-service.js";

export const ACCOUNT_IPC_METHODS = ["account-status", "account-login-submit"] as const;
export type AccountIpcMethod = (typeof ACCOUNT_IPC_METHODS)[number];

export function isAccountIpcMethod(method: string): method is AccountIpcMethod {
  return (ACCOUNT_IPC_METHODS as readonly string[]).includes(method);
}

const submitParams = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).optional(),
  code: z.string().min(1).max(4096),
});

export async function handleAccountIpc(
  service: AccountService,
  method: AccountIpcMethod,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (method === "account-status") {
    const s = await service.status();
    // Summaries are already token-free (sha prefix + expiry + tier only).
    return {
      pendingLogin: service.pendingLogin(),
      activeSlot: s.activeSlot,
      live: s.live,
      slots: s.slots.map((slot) => ({
        ...slot,
        email: s.configured.find((c) => c.name === slot.name)?.email ?? null,
      })),
    };
  }

  const parsed = submitParams.safeParse(params);
  if (!parsed.success) {
    return { accepted: false, error: "expected { code, sessionId? }" };
  }
  const r = await service.submitCode(parsed.data.sessionId, parsed.data.code);
  if (!r.accepted) return { accepted: false, error: r.error };
  const o = r.outcome;
  return o.status === "succeeded"
    ? { accepted: true, status: o.status, email: o.email }
    : { accepted: true, status: o.status, detail: o.detail };
}
