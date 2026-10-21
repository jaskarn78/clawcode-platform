/**
 * 999.143 — the transcription progress card.
 *
 * ONE card per job, edited in place. The alternative — a new message per phase —
 * turns a 40-minute recording into five notifications and buries the channel.
 * Discord's edit is cheap and the card is the same message throughout, so the
 * owner watches one thing change rather than scrolling a log.
 *
 * The card is deliberately honest about what it knows: while the duration is
 * unknown there is no ETA line rather than a fabricated one, and the bar never
 * shows 100% until the worker has actually written the sentinel.
 */
import type { Cv2Spec } from "../discord/cv2-renderer.js";
import { bar, humanDuration, type JobState, type Phase } from "./progress.js";

const ACCENT = {
  running: 0x3987e5,   // blue — in flight
  done: 0x5ddba0,      // green — transcript ready
  failed: 0xd95926,    // orange — needs a human
} as const;

const PHASE_LABEL: Record<Phase, string> = {
  queued: "Queued",
  extracting: "Extracting audio",
  transcribing: "Transcribing",
  diarizing: "Identifying speakers",
  writing: "Writing transcript",
  done: "Done",
};

/** What the owner should understand is happening, in their terms not ours. */
const PHASE_BLURB: Record<Phase, string> = {
  queued: "Waiting for the GPU. Another job is ahead of this one.",
  extracting: "Pulling the audio track out of the file.",
  transcribing: "Turning speech into text on the GPU.",
  diarizing: "Working out who said what.",
  writing: "Assembling the final transcript.",
  done: "Transcript ready.",
};

export type CardInput = {
  readonly state: JobState;
  readonly fileName: string;
  /** Position in the queue when this job has not started yet (1 = next). */
  readonly queuePosition?: number;
  /** Set when the job failed; shown instead of progress. */
  readonly failureReason?: string;
};

function mono(lines: readonly string[]): string {
  return "```\n" + lines.join("\n") + "\n```";
}

export function buildProgressCard(input: CardInput): Cv2Spec {
  const { state, fileName, queuePosition, failureReason } = input;

  if (failureReason) {
    return {
      accentColor: ACCENT.failed,
      blocks: [
        { type: "text", content: `### 🎙️ Transcription failed\n${fileName}` },
        { type: "separator", divider: true },
        { type: "text", content: `${failureReason}\n\n_Jas has been flagged. The recording was not transcribed._` },
      ],
    };
  }

  const done = state.phase === "done";
  const header = done
    ? `### ✅ Transcript ready\n${fileName}`
    : `### 🎙️ Transcribing\n${fileName}`;

  const rows: string[] = [`${bar(state.pct)}  ${state.pct}%`];
  if (state.audioSeconds) {
    rows.push(`${"Audio".padEnd(9)}${humanDuration(state.audioSeconds)}`);
  }
  if (!done && state.etaSeconds !== undefined) {
    rows.push(`${"Left".padEnd(9)}~${humanDuration(state.etaSeconds)}`);
  }
  if (done && state.elapsedSeconds !== undefined) {
    rows.push(`${"Took".padEnd(9)}${humanDuration(state.elapsedSeconds)}`);
  }

  const status =
    queuePosition && queuePosition > 0 && state.phase === "queued"
      ? `**Queued** — ${queuePosition === 1 ? "next up" : `${queuePosition} jobs ahead`}. ${PHASE_BLURB.queued}`
      : `**${PHASE_LABEL[state.phase]}** — ${PHASE_BLURB[state.phase]}`;

  return {
    accentColor: done ? ACCENT.done : ACCENT.running,
    blocks: [
      { type: "text", content: header },
      { type: "separator", divider: true },
      { type: "text", content: `${mono(rows)}\n${status}` },
    ],
  };
}

/**
 * How often to redraw. Phase changes are rare; the bar moves smoothly. Editing
 * every few seconds would burn rate limit for no visible benefit, so the card
 * is redrawn only when the PERCENTAGE or the PHASE actually changes.
 */
export function shouldRedraw(prev: JobState | undefined, next: JobState): boolean {
  if (!prev) return true;
  return prev.phase !== next.phase || prev.pct !== next.pct;
}
