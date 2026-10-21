/**
 * Research auto-routing (2026-09-26, operator: "update Client A's agents so they
 * use research agents when Client A wants a deep dive or even if he asks for a
 * workflow … add a hook/trigger").
 *
 * Two deterministic triggers, both behind `research.autoRoute` (default off)
 * and both only where research subagents are live in the session:
 *
 *   1. MESSAGE TRIGGER — a Discord message that asks for a deep dive, research
 *      or a workflow gets a short `<research-routing>` block prepended to that
 *      turn (TurnDispatcher, beside the output-style overlay), telling the
 *      agent to use researcher subagents instead of searching inline or
 *      launching a workflow.
 *   2. WORKFLOW GUARD — a research-only `start_workflow` from a live Discord
 *      turn is denied by the research launch gate with a pointer to
 *      researchers. Workflows that produce a deliverable (a PDF, a post, a
 *      dashboard …) and named templates pass untouched, and so does anything
 *      from a scheduled turn (researchers can't start there).
 *
 * Measured basis (Client A's four agents, 08-26 → 09-26): 422 research-shaped
 * turns; the same 5-step research workflow ran 3× in 15 min on 09-25; inline
 * research in the lead's context was ~47% of the visible new tokens.
 *
 * Pure module: no I/O.
 */

/** The in-session name of the daemon's workflow tool (== WORKFLOW_TOOL_DISALLOW; pinned by a test). */
export const START_WORKFLOW_TOOL = "mcp__clawcode__start_workflow";

/**
 * Request forms that mean "research this". Deliberately narrow — measured on
 * Client A's 422 research-shaped turns, bare "workflow" / "research" / "best way"
 * caught status questions ("is there a workflow running?"), drafting ("I want
 * to write something that I'm researching…") and small talk ("text message
 * seems the best way to go"). Plain "verify" / "fact check" / "review this"
 * are NOT here: the agent handles those inline or per its own rules.
 */
const RESEARCH_INTENT_RES: readonly RegExp[] = [
  /\bdeep[\s-]?dive\b/i,
  /\bin[\s-]?depth\b/i,
  /\b(?:thorough|comprehensive|detailed|full) (?:research|analysis|breakdown|comparison|investigation)\b/i,
  /\b(?:do|run|conduct|perform|start|need)(?: (?:some|more|a|the|deep|deeper|proper|real|your))* research\b/i,
  /\bresearch (?:this|that|it|these|those|the|on|into|whether|how|what|which|who|why|where|options?|alternatives|if)\b/i,
  /\b(?:look|dig) into\b/i,
  /\binvestigate\b/i,
  /\b(?:run|start|do|launch|kick off|spin up|set up|create|use)(?: (?:a|an|another|the|new|up))* workflows?\b/i,
  /\bworkflows? (?:on|to research|to find|to look)\b/i,
  /\bfind (?:me )?the best\b/i,
  /\bpros and cons\b/i,
  /\bwhat (?:are |do )?people (?:are )?(?:saying|say|think)\b/i,
  /\breviews? online\b/i,
  /\breddit\b/i,
];

const CHANNEL_BLOCK_RE = /<channel\b[^>]*>([\s\S]*?)<\/channel>/gi;

/**
 * What the user actually typed. Discord turns wrap it in `<channel …>` tags;
 * a quick-lane recap, quoted reply context and attachment notes sit OUTSIDE
 * those tags and must never trigger routing. No tags → the whole message.
 */
export function userTextOf(message: string): string {
  if (typeof message !== "string") return "";
  const blocks = [...message.matchAll(CHANNEL_BLOCK_RE)].map((m) => m[1] ?? "");
  return blocks.length > 0 ? blocks.join("\n") : message;
}

/** True when what the user typed asks for research, a deep dive or a workflow. */
export function isResearchIntent(message: string): boolean {
  const text = userTextOf(message);
  return RESEARCH_INTENT_RES.some((re) => re.test(text));
}

/** Prepended to the turn when the message trigger fires. Kept short: it rides every such turn. */
export const RESEARCH_ROUTE_BLOCK = [
  "<research-routing>",
  "This message asks for research (a deep dive, \"look into\", a workflow or similar). Use researcher subagents, not inline searching and not start_workflow:",
  "- Split it into distinct sub-questions: 1 researcher for a single check, 2-4 for anything broader. Launch them in parallel with the Agent tool (subagent_type \"researcher\"), each with a self-contained prompt.",
  "- Researchers should use current, reputable sources: primary sources for every figure, expert reviews, and community sources such as Reddit for product or experience questions (labelled as opinion).",
  "- When they finish, write ONE synthesis: the answer first, every figure sourced or marked [unverified], conflicts named.",
  "If the request is really a deliverable (a PDF, a draft, a post, a file), asks about work already running, or the answer is already in front of you, just do that instead.",
  "</research-routing>",
  "",
].join("\n");

/**
 * The message trigger. Detection runs on the RAW user message (so the memory
 * block never triggers it); the block goes in front of the already-augmented
 * message. Returns `augmented` unchanged when off or not a research ask.
 */
export function withResearchRoute(rawMessage: string, augmented: string, enabled: boolean): string {
  if (!enabled || !isResearchIntent(rawMessage)) return augmented;
  return RESEARCH_ROUTE_BLOCK + augmented;
}

/**
 * A workflow step "makes something" rather than "finds something" when its
 * short step id names a deliverable, or its prompt asks outright to produce,
 * send or post one. Step ids get the broad word list (they're a few words,
 * chosen by the agent to say what the step is); prompts only the strong
 * phrases, because research prompts are long and full of words like "page",
 * "chart" or "fee schedule". Biased toward "mixed": a false "mixed" just lets
 * the workflow run as before; a false "research-only" would bounce a real job.
 */
const DELIVERABLE_STEP_ID_RE =
  /\b(?:pdf|docx?|doc|excel|spreadsheet|sheet|slides?|deck|dashboard|planner|draft|e-?mail|send|post|publish|schedule|calendar|create|build|generate|render|upload|update|edit|fix|install|deploy|book|order|buy|cv2|card|morning|eod|hook|image|video|reel|chart|website|page)\b/i;
const DELIVERABLE_PROMPT_RE =
  /\b(?:(?:build|create|generate|render|make|produce|draft|write|design) (?:me )?(?:a |an |the )?(?:pdf|docx?|document|spreadsheet|excel|slides?|deck|dashboard|e-?mail|post|letter|memo|image|chart|web ?page|website)|send (?:it|this|the|an?)\b|post (?:it|this|the|to)\b|upload|publish|schedule (?:a|an|the|it)\b|book (?:a|an|the)\b|place (?:an|the) order|add (?:it )?to (?:the )?cart)/i;

type StepLike = Readonly<{ stepId?: unknown; prompt?: unknown }>;

function stepsOf(input: unknown): readonly StepLike[] {
  if (input === null || typeof input !== "object") return [];
  const i = input as { steps?: unknown; waves?: unknown };
  if (Array.isArray(i.steps)) return i.steps as StepLike[];
  if (Array.isArray(i.waves)) return (i.waves as unknown[]).flatMap((w) => (Array.isArray(w) ? (w as StepLike[]) : []));
  return [];
}

function stepMakesSomething(s: StepLike): boolean {
  const id = typeof s.stepId === "string" ? s.stepId : "";
  const prompt = typeof s.prompt === "string" ? s.prompt : "";
  return DELIVERABLE_STEP_ID_RE.test(id) || DELIVERABLE_PROMPT_RE.test(prompt);
}

/**
 * True when a `start_workflow` input only gathers information. Named
 * templates are operator-curated and never counted as research-only here.
 */
export function isResearchOnlyWorkflow(input: unknown): boolean {
  if (input === null || typeof input !== "object") return false;
  const template = (input as { template?: unknown }).template;
  if (typeof template === "string" && template.length > 0) return false;
  const steps = stepsOf(input);
  if (steps.length === 0) return false;
  return steps.every((s) => !stepMakesSomething(s));
}

export const RESEARCH_WORKFLOW_DENY =
  "Research-only workflows are handled by researcher subagents on this agent. Launch researchers instead " +
  "(Agent tool, subagent_type \"researcher\"): one per sub-question, up to 4 in parallel, each with a " +
  "self-contained prompt, then write one synthesis with sources. If this workflow must produce a " +
  "deliverable (a document, PDF, post or file), add that step explicitly and call start_workflow again.";
