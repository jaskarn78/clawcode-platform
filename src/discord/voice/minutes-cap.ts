/**
 * Phase 135 Plan 03 Task 3 — monthly voice-minutes cap tracker.
 *
 * Per-agent soft cap on combined Deepgram STT + ElevenLabs TTS seconds.
 * When `voice.monthlyMinutesCap` is set on the agent's voice config and
 * the accumulated seconds exceed that cap, VoiceManager disconnects the
 * agent's voice session and posts a warning to the agent's text channel.
 *
 * Persistence shape (`<memoryPath>/voice-minutes.json`):
 *
 *   { "month": "2026-05", "secondsUsed": 1234 }
 *
 * UTC-month boundary triggers reset. Reset is LAZY (per RESEARCH Open
 * Q6 recommendation): on construction AND on every accumulator call,
 * compare the stored month to the current UTC month. If different,
 * reset to {month: currentUtcMonth(), secondsUsed: 0} and rewrite the
 * file. No cron registration needed — the daemon could be offline at
 * the actual rollover moment and the next utterance still resets
 * correctly.
 *
 * Immutability: every state mutation builds a new object before
 * assigning to `this.state` (coding-style.md rule). The file write is
 * synchronous (tiny file, ~50 bytes; sync simplifies error handling
 * over the per-utterance / per-synthesis path).
 *
 * Cost-runaway threat (T-135-03-03) mitigation: combined with the
 * voice ACL gate (T-135-03-01), only allowlisted users can trigger
 * spend, and total spend is capped per agent per month. A corrupted
 * counter file (T-135-03-05 accept) resets to the current month with 0
 * seconds — worst-case 1 month of unbounded spend on a corrupted file;
 * operator mitigation is to rotate the op:// keys at month boundary
 * (documented in the UAT runbook).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Minimal log surface — narrows pino's Logger. */
type MinutesLog = {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  debug: (obj: Record<string, unknown>, msg?: string) => void;
};

type MinutesState = {
  readonly month: string;
  readonly secondsUsed: number;
};

export type MinutesTrackerInit = {
  readonly agentName: string;
  readonly memoryPath: string;
  readonly log: MinutesLog;
};

/**
 * `YYYY-MM` UTC month string (e.g., `"2026-05"`). The leading-zero
 * month padding makes the strings sort lexicographically.
 */
export function currentUtcMonth(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export class MinutesTracker {
  private readonly filePath: string;
  private readonly log: MinutesLog;
  private readonly agentName: string;
  private state: MinutesState;

  constructor(init: MinutesTrackerInit) {
    this.agentName = init.agentName;
    this.log = init.log;
    this.filePath = join(init.memoryPath, "voice-minutes.json");
    this.state = this.loadOrInit();
  }

  /** Current accumulated seconds in the active month. */
  secondsUsedThisMonth(): number {
    return this.state.secondsUsed;
  }

  /**
   * Add Deepgram utterance duration. `seconds` may be a fractional
   * value (e.g., 1.234 — Deepgram returns durations to ms precision).
   * Negative or NaN inputs are ignored with a debug log.
   */
  addUtteranceSeconds(seconds: number): void {
    this.add(seconds, "utterance");
  }

  /**
   * Add ElevenLabs synthesis duration. RESEARCH-derived approximation
   * for English speech at conversational pace: `responseTextLength / 15`
   * (≈15 chars/s). Accept ±10% drift for a soft cap (T-135-03-05).
   */
  addSynthesisSeconds(seconds: number): void {
    this.add(seconds, "synthesis");
  }

  /**
   * `cap === undefined` → always false (no cap configured).
   * `cap === N` → true once accumulated seconds ≥ N * 60.
   */
  isCapExceeded(capMinutes: number | undefined): boolean {
    if (capMinutes === undefined) return false;
    return this.state.secondsUsed >= capMinutes * 60;
  }

  /**
   * Reset the counter if the current UTC month differs from the
   * stored one. Idempotent — safe to call on every accumulator call,
   * which is how lazy rollover is implemented internally.
   */
  rolloverIfNeeded(): void {
    const now = currentUtcMonth();
    if (this.state.month !== now) {
      this.log.info(
        { agent: this.agentName, fromMonth: this.state.month, toMonth: now },
        "voice minutes counter: UTC month rollover — resetting",
      );
      this.state = { month: now, secondsUsed: 0 };
      this.write();
    }
  }

  private add(seconds: number, source: "utterance" | "synthesis"): void {
    if (!Number.isFinite(seconds) || seconds < 0) {
      this.log.debug(
        { agent: this.agentName, seconds, source },
        "voice minutes: ignored non-positive/non-finite seconds",
      );
      return;
    }
    this.rolloverIfNeeded();
    // Immutable update — coding-style.md rule.
    this.state = {
      month: this.state.month,
      secondsUsed: this.state.secondsUsed + seconds,
    };
    this.write();
  }

  private loadOrInit(): MinutesState {
    const now = currentUtcMonth();
    if (!existsSync(this.filePath)) {
      const fresh: MinutesState = { month: now, secondsUsed: 0 };
      this.ensureDir();
      this.writeStatic(fresh);
      return fresh;
    }
    try {
      const raw = readFileSync(this.filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<MinutesState>;
      const month = typeof parsed.month === "string" ? parsed.month : now;
      const secondsUsed =
        typeof parsed.secondsUsed === "number" && Number.isFinite(parsed.secondsUsed)
          ? parsed.secondsUsed
          : 0;
      // Stored month != current UTC month → reset.
      if (month !== now) {
        const fresh: MinutesState = { month: now, secondsUsed: 0 };
        this.writeStatic(fresh);
        return fresh;
      }
      return { month, secondsUsed };
    } catch (err) {
      // Corrupt file — log loudly and start fresh. T-135-03-05 (accept):
      // worst case is one month of uncapped spend on a corrupted file.
      this.log.error(
        {
          agent: this.agentName,
          filePath: this.filePath,
          error: err instanceof Error ? err.message : String(err),
        },
        "voice-minutes.json unreadable — resetting to current month, 0 seconds",
      );
      const fresh: MinutesState = { month: now, secondsUsed: 0 };
      this.writeStatic(fresh);
      return fresh;
    }
  }

  private ensureDir(): void {
    try {
      mkdirSync(this.filePath.replace(/\/voice-minutes\.json$/, ""), {
        recursive: true,
      });
    } catch (err) {
      this.log.warn(
        {
          agent: this.agentName,
          error: err instanceof Error ? err.message : String(err),
        },
        "voice-minutes.json directory create failed (will likely fail to write)",
      );
    }
  }

  private write(): void {
    this.writeStatic(this.state);
  }

  private writeStatic(state: MinutesState): void {
    // Phase 135 REVIEW WR-04 — atomic write via temp-file + rename.
    // The previous implementation called writeFileSync directly against
    // the final path, which is non-atomic: a crash mid-write yields
    // corrupt JSON, and loadOrInit resets the counter to zero on next
    // boot (T-135-03-05 accept — but the recovery is itself a soft
    // cap-bypass). Write to a sibling temp file and renameSync into
    // place; POSIX rename is atomic, so readers either see the old
    // file or the complete new file — never a half-written one.
    //
    // The temp-file path is .tmp-suffixed; unlink it on rename failure
    // so we don't accumulate stray temp files. Process-pid in the
    // suffix prevents concurrent writers (different agents writing
    // their own voice-minutes.json) from racing each other if their
    // memoryPath ever coincides (defensive — agents shouldn't share
    // memoryPath today, but cheap insurance).
    //
    // ACCEPTED DEBT — TODO(135.3): track consecutive write failures
    // and disconnect the session after N (e.g., 5) failed writes —
    // fail-closed instead of fail-open. The plumbing requires a
    // callback from MinutesTracker → VoiceSession → VoiceManager.leave,
    // which crosses three files outside MinutesTracker's natural edit
    // surface; defer to a v3.0.1 polish pass per WR-04 task budget.
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, JSON.stringify(state), "utf-8");
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      // Cleanup: if the rename failed (or the tmp write succeeded but
      // rename threw), try to remove the temp file. Swallow any error
      // — the original write error is what the operator needs to see.
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        /* best-effort cleanup */
      }
      this.log.error(
        {
          agent: this.agentName,
          filePath: this.filePath,
          error: err instanceof Error ? err.message : String(err),
        },
        "voice-minutes.json write failed — counter is in-memory only this turn",
      );
    }
  }
}
