/**
 * 999.143 — turn the Unraid worker's `progress.json` into something a human card
 * can show: a phase, an honest percentage, and a remaining-time estimate.
 *
 * The worker already writes one small JSON per job at every phase transition:
 *
 *   { job, phase, audio_seconds, job_started_at, phase_started_at, worker }
 *
 * It does NOT emit a percentage, and it should not have to — the phase plus the
 * clock is enough, and deriving the number here keeps the GPU worker simple and
 * the presentation logic testable.
 *
 * THE PERCENTAGE IS AN ESTIMATE AND IS TREATED AS ONE. It is monotonic (never
 * goes backwards), it is clamped below the next phase's floor so a slow phase
 * cannot overtake reality, and it never reads 100% until the job is actually
 * done. A progress bar that hits 100% and then sits there is worse than no bar.
 */

/** Phases the worker emits, in order. */
export const PHASES = ["queued", "extracting", "transcribing", "diarizing", "writing", "done"] as const;
export type Phase = (typeof PHASES)[number];

/**
 * Where each phase STARTS on the bar, and the share it owns. Measured against
 * real jobs on this pipeline: transcription dominates, diarization is the other
 * heavy half, extraction and writing are rounding errors.
 */
const PHASE_SPAN: Record<Phase, { from: number; to: number }> = {
  queued: { from: 0, to: 2 },
  extracting: { from: 2, to: 6 },
  transcribing: { from: 6, to: 62 },
  diarizing: { from: 62, to: 94 },
  writing: { from: 94, to: 99 },
  done: { from: 100, to: 100 },
};

/** GPU throughput: roughly real-time ÷ 6 end to end. */
const SPEED_FACTOR = 6;

export type WorkerProgress = {
  readonly job: string;
  readonly phase: string;
  readonly audio_seconds?: number;
  readonly job_started_at?: number;
  readonly phase_started_at?: number;
  readonly worker?: string;
};

export type JobState = {
  readonly job: string;
  readonly phase: Phase;
  readonly pct: number;
  /** Seconds of processing still expected, or undefined when unknowable. */
  readonly etaSeconds?: number;
  readonly audioSeconds?: number;
  readonly elapsedSeconds?: number;
  readonly failed?: boolean;
};

export function isPhase(v: string): v is Phase {
  return (PHASES as readonly string[]).includes(v);
}

/** Total processing time we expect for this job, in seconds. */
export function expectedTotalSeconds(audioSeconds: number | undefined): number | undefined {
  if (!audioSeconds || audioSeconds <= 0) return undefined;
  return audioSeconds / SPEED_FACTOR;
}

/**
 * Derive the display state. `floor` is the last percentage we showed for this
 * job, so the bar can never run backwards across polls — a phase transition
 * arriving late must not rewind a bar the user already saw.
 */
export function deriveState(
  raw: WorkerProgress,
  now: number = Date.now(),
  floor = 0,
): JobState {
  const phase: Phase = isPhase(raw.phase) ? raw.phase : "queued";
  const span = PHASE_SPAN[phase];
  const audioSeconds = raw.audio_seconds;
  const total = expectedTotalSeconds(audioSeconds);

  if (phase === "done") {
    return { job: raw.job, phase, pct: 100, etaSeconds: 0, audioSeconds, elapsedSeconds: elapsed(raw, now) };
  }

  let pct = span.from;
  if (raw.phase_started_at && total) {
    // How far through THIS phase we are, by the clock, against the share of the
    // total this phase is expected to take.
    const phaseElapsed = Math.max(0, now / 1000 - raw.phase_started_at);
    const phaseBudget = (total * (span.to - span.from)) / 100;
    if (phaseBudget > 0) {
      const within = Math.min(1, phaseElapsed / phaseBudget);
      pct = span.from + within * (span.to - span.from);
    }
  }
  // Never overtake the phase we are actually in, and never rewind.
  pct = Math.max(floor, Math.min(pct, span.to));

  return {
    job: raw.job,
    phase,
    pct: Math.round(pct),
    etaSeconds: remaining(total, pct),
    audioSeconds,
    elapsedSeconds: elapsed(raw, now),
  };
}

function elapsed(raw: WorkerProgress, now: number): number | undefined {
  return raw.job_started_at ? Math.max(0, Math.round(now / 1000 - raw.job_started_at)) : undefined;
}

function remaining(total: number | undefined, pct: number): number | undefined {
  if (!total) return undefined;
  return Math.max(0, Math.round((total * (100 - pct)) / 100));
}

/** "4 min", "45s", "1h 10m" — short enough for a card line. */
export function humanDuration(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** A 12-cell bar. Text, because a CV2 card has no native progress widget. */
export function bar(pct: number, width = 12): string {
  const filled = Math.max(0, Math.min(width, Math.round((pct / 100) * width)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}
