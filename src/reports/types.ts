/**
 * The document model both report PDFs are rendered from.
 *
 * DESIGN RULE: every field beyond `workflowId` / `steps` is optional, and each
 * document builder has a deterministic fallback for each one. The synthesis
 * turn that fills `synthesis` is an LLM call and therefore the least reliable
 * link in the chain - so the reports must be publishable without it. A missing
 * synthesis costs polish (no bottom-line paragraph, gists instead of an
 * editor's condensation); it never costs the document.
 */

export interface ReportStep {
  readonly stepId: string;
  /** `done` renders as delivered; anything else renders as a failure. */
  readonly status: string;
  /** The step's instruction, shown as provenance in the full report. */
  readonly prompt?: string;
  /** The worker's full markdown result. */
  readonly result?: string;
  readonly error?: string;
  readonly durationMs?: number;
}

/** The optional editorial layer, produced by the synthesis turn. */
export interface ReportSynthesis {
  /** Bottom line up front - the paragraph a reader can stop after. */
  readonly bluf?: string;
  /** Standfirst under the masthead. One sentence. */
  readonly dek?: string;
  /** Document title. Falls back to the workflow id when absent. */
  readonly title?: string;
  readonly keyFindings?: readonly string[];
  /** stepId -> a condensed markdown retelling of that step. */
  readonly perStep?: Readonly<Record<string, string>>;
  readonly risks?: readonly string[];
  readonly nextSteps?: readonly string[];
  /** Phase 999.129 — deltas since the previous run of a recurring workflow. */
  readonly changes?: readonly string[];
}

export interface ReportDoc {
  readonly workflowId: string;
  readonly agentName: string;
  /** Epoch ms; injected rather than read from the clock so renders are testable. */
  readonly generatedAt: number;
  readonly elapsedMs?: number;
  readonly steps: readonly ReportStep[];
  readonly synthesis?: ReportSynthesis;
}
