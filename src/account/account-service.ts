/**
 * Phase 999.176 — daemon-side orchestrator for the fleet account swap.
 *
 * Owns every credential mutation. Discord (the `/clawcode-account` flow)
 * and the CLI (`clawcode account submit-code`) are only inputs:
 *
 *   status → preflight(target) ──ok──────────────────────┐
 *                    │                                    ▼
 *                    └─fail→ startLogin(target) → code → scheduleSwap → restart
 *                             (Mac agent + manual paste       (applied at boot by
 *                              race; first valid code wins)    pending-swap.ts)
 *
 * Starting a login or a swap is reachable only from the admin-gated slash
 * command. Agents get exactly one verb, submit-code, which is useless
 * without the session id and is followed by the signed-in-email gate.
 */

import {
  readAccountStatus,
  SLOT_NAME_RE,
  type AccountStatus,
} from "./credential-slots.js";
import {
  LoginSession,
  preflightSlot,
  type OAuthCliDeps,
  type PreflightResult,
  type SubmitResult,
} from "./oauth-cli.js";
import { writePendingSwap, type PendingSwapPaths } from "./pending-swap.js";

export type AccountSlotConfig = {
  readonly name: string;
  readonly email: string;
  readonly opItem?: string;
};

export type AccountServiceDeps = {
  readonly oauth: OAuthCliDeps;
  readonly paths: PendingSwapPaths;
  /** Read lazily so a yaml reload applies without a restart. */
  readonly getSlots: () => readonly AccountSlotConfig[];
  /** SIGHUP self → graceful shutdown → systemd restart (exit 129). */
  readonly requestRestart: () => void;
  readonly now?: () => number;
};

export class AccountServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountServiceError";
  }
}

export type AccountStatusView = AccountStatus & {
  readonly configured: readonly AccountSlotConfig[];
};

export class AccountService {
  private session: LoginSession | null = null;
  /** Serializes preflight/login/swap so two clicks can't interleave file writes. */
  private busy: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: AccountServiceDeps) {}

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.busy.then(fn, fn);
    this.busy = run.catch(() => undefined);
    return run;
  }

  slotConfig(name: string): AccountSlotConfig {
    const slot = this.deps.getSlots().find((s) => s.name === name);
    if (slot === undefined || !SLOT_NAME_RE.test(slot.name)) {
      throw new AccountServiceError(`'${name}' is not a configured account slot`);
    }
    return slot;
  }

  async status(): Promise<AccountStatusView> {
    const configured = this.deps.getSlots();
    const status = await readAccountStatus(
      this.deps.oauth.configDir,
      configured.map((s) => s.name),
    );
    return { ...status, configured };
  }

  private async assertSwitchTarget(target: string): Promise<AccountSlotConfig> {
    const slot = this.slotConfig(target);
    const status = await this.status();
    if (status.activeSlot === null) {
      throw new AccountServiceError(
        "The live credential isn't labeled with a slot yet — label it once with the ssh tool (`clawcode-account.sh snapshot <name>`).",
      );
    }
    if (status.activeSlot === target) {
      throw new AccountServiceError(`The fleet is already on '${target}'.`);
    }
    return slot;
  }

  preflight(target: string): Promise<PreflightResult> {
    return this.exclusive(async () => {
      const slot = await this.assertSwitchTarget(target);
      return preflightSlot(this.deps.oauth, slot.name, slot.email);
    });
  }

  /** Start (or restart) the single login session for `target`. */
  startLogin(target: string): Promise<LoginSession> {
    return this.exclusive(async () => {
      const slot = await this.assertSwitchTarget(target);
      this.session?.cancel("superseded by a new login");
      const session = await LoginSession.start(this.deps.oauth, slot.name, slot.email);
      this.session = session;
      void session.done.finally(() => {
        if (this.session === session) this.session = null;
      });
      return session;
    });
  }

  getSession(id: string): LoginSession | null {
    return this.session !== null && this.session.id === id ? this.session : null;
  }

  /**
   * The login the daemon itself started and is waiting on. The Mac agent
   * reads the URL from HERE, never from its turn text, so a forged turn
   * can't steer it to a phishing page.
   */
  pendingLogin(): { id: string; url: string; email: string; expiresAt: number } | null {
    const s = this.session;
    if (s === null || !s.isOpen) return null;
    return { id: s.id, url: s.authorizeUrl, email: s.email, expiresAt: s.expiresAt };
  }

  /** Submit to the given session, or to the pending one when no id is given. */
  async submitCode(sessionId: string | undefined, code: string): Promise<SubmitResult> {
    const session = sessionId === undefined ? this.session : this.getSession(sessionId);
    if (session === null) {
      return { accepted: false, error: "No active login with that id — it may have finished or expired." };
    }
    return session.submitCode(code);
  }

  cancelLogin(sessionId: string): void {
    this.getSession(sessionId)?.cancel();
  }

  /**
   * Record the swap intent and restart the daemon; the swap itself happens
   * at the next boot, before any agent spawns.
   */
  scheduleSwap(input: {
    readonly target: string;
    readonly requestedBy: string;
    readonly channelId: string;
  }): Promise<void> {
    return this.exclusive(async () => {
      await this.assertSwitchTarget(input.target);
      await writePendingSwap(this.deps.paths, {
        target: input.target,
        requestedBy: input.requestedBy,
        channelId: input.channelId,
        requestedAt: (this.deps.now ?? Date.now)(),
      });
      this.session?.cancel("swap scheduled");
      this.deps.requestRestart();
    });
  }
}
