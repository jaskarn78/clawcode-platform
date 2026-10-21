/**
 * Phase 999.173 — the research card's Discord port.
 *
 * The tracker lives in the session handle (manager layer); posting and editing
 * a Discord message with buttons needs the bot client (daemon layer). The
 * daemon registers ONE port here at boot; every tracker paints through it.
 * Absent (tests, `clawcode run`, pre-boot) → the card is skipped and research
 * still works — the card is progress UI, never a delivery path.
 */

import type { ResearchCardSessionView } from "./research-registry.js";

export type ResearchCardOutcome = "done" | "timeout" | "interrupted";

/** Everything the renderer needs for one paint. */
export type ResearchCardSnapshot = Readonly<{
  session: ResearchCardSessionView;
  /** Latest folded interim line (self-fired parent turn), trimmed; null when none. */
  interim: string | null;
  /** Null while research runs; set once the card settles. */
  settled: Readonly<{ at: number; outcome: ResearchCardOutcome }> | null;
  /** The most significant reason a researcher did not finish, e.g. "usage limit reached, resets 5:30 PM PT". */
  reason?: string | null;
  /** Header suffixes shown while running, e.g. "limited to 1 near usage limit", "budget reached". */
  notes?: readonly string[];
  /** Where the findings journal is saved, relative to the agent workspace (e.g. "research/2026-09-25-155…/"). */
  savedTo?: string;
  /** Every researcher is done and the synthesis is being written, since then. */
  writingSince?: number;
  /** Paint time — elapsed is computed from this, so renders are pure. */
  now: number;
}>;

export interface ResearchCardPort {
  /** Post a new card in `channelId`; resolves the message id. */
  post(channelId: string, snapshot: ResearchCardSnapshot): Promise<string>;
  /** Replace the card's content + buttons in place. */
  edit(channelId: string, messageId: string, snapshot: ResearchCardSnapshot): Promise<void>;
  /** Show the typing indicator in `channelId` (~10 s). Optional: absent → no typing. */
  typing?(channelId: string): Promise<void>;
}

let port: ResearchCardPort | undefined;

export function setResearchCardPort(p: ResearchCardPort | undefined): void {
  port = p;
}

export function getResearchCardPort(): ResearchCardPort | undefined {
  return port;
}
