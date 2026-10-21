/**
 * UX-C (2026-08-26) — live verification status for hold-mode placeholders.
 *
 * Hold mode (`verification.holdDelivery`) suppresses draft
 * streaming so nothing unverified renders; without this module the
 * operator stares at a static "💠 *working…*" for the whole turn. The
 * `onToolUse` sink (name-only, manager metadata) lets the placeholder
 * narrate what the agent is DOING — "verifying — searching the web…" —
 * which is the trust product made visible.
 *
 * INVARIANT: nothing model-generated may render. Tool NAMES are SDK/
 * manager metadata and map to a FIXED phrase set below; tool ARGUMENTS
 * are model-generated and are never available here by construction
 * (onToolUse carries only the name).
 *
 * Pure module: no discord.js, no Date.now — the bridge owns the edit.
 */

import { ELAPSED_HEADER_FLOOR_SECS, formatElapsed } from "./duration-format.js";

/** Fixed, closed phrase set — the ONLY strings that can ever render. */
const PHRASES = Object.freeze({
  search: "searching the web",
  fetch: "reading a source",
  market: "checking market data",
  files: "reviewing files",
  advisor: "consulting the advisor",
  default: "working",
});

export type HoldStatusPhrase = (typeof PHRASES)[keyof typeof PHRASES];

/**
 * Map an SDK tool name to a fixed status phrase. Matching is defensive:
 * an unknown or adversarial name always lands on the default phrase —
 * the input string itself NEVER reaches the output.
 */
export function toolStatusPhrase(toolName: string): HoldStatusPhrase {
  const n = toolName.toLowerCase();
  if (n.includes("websearch") || n.includes("web_search") || n.includes("brave") || n === "search" || n.endsWith("__search")) {
    return PHRASES.search;
  }
  if (n.includes("webfetch") || n.includes("web_fetch")) return PHRASES.fetch;
  if (n.includes("finnhub")) return PHRASES.market;
  if (n.includes("ask_advisor") || n.includes("advisor")) return PHRASES.advisor;
  if (/^(read|grep|glob|ls)$/.test(n)) return PHRASES.files;
  return PHRASES.default;
}

/** Composed placeholder body for a status phrase (hold mode). */
export function composeHoldStatus(phrase: HoldStatusPhrase): string {
  return `🔎 *verifying — ${phrase}…*`;
}

/**
 * Edit throttle for status updates: an edit fires only when the phrase
 * CHANGED and the minimum interval elapsed. Dropped updates are dropped
 * (status is cosmetic; the next differing tool refreshes it). Purely
 * decision-shaped — caller supplies `now`.
 */
export class HoldStatusThrottle {
  private lastPhrase: string | null = null;
  private lastEmitAt = 0;

  constructor(private readonly intervalMs: number) {}

  /**
   * Returns the composed status body to edit in, or null when throttled
   * (same phrase, or interval not yet elapsed).
   */
  next(toolName: string, now: number): string | null {
    const phrase = toolStatusPhrase(toolName);
    if (phrase === this.lastPhrase) return null;
    if (now - this.lastEmitAt < this.intervalMs) return null;
    this.lastPhrase = phrase;
    this.lastEmitAt = now;
    return composeHoldStatus(phrase);
  }
}

/**
 * 999.63d streamStatus — dynamic activity descriptions (ADDENDUM).
 *
 * Unlike hold mode (strict fixed phrases — nothing model-generated may
 * render while a draft is being WITHHELD), streamStatus narrates real
 * activity: the hostname being read, the (sanitized) search query. The
 * draft itself streams publicly seconds later, so echoing a sanitized
 * fragment of tool input is consistent with the mode's disclosure level.
 *
 * SANITIZER INVARIANT: any echoed content passes `sanitizeEcho` — @ is
 * stripped (no @everyone / @here / mention injection via a hostile URL
 * or query), backticks / newlines / markdown breakers are stripped,
 * whitespace collapses, and a hard length cap applies. Adversarial
 * fixtures pin this in the unit tests.
 */

/** Hard cap for any echoed fragment (query text, hostname). */
export const ECHO_MAX_CHARS = 60;

/** Strip everything that could break out of an inline status line. */
export function sanitizeEcho(raw: unknown, maxChars: number = ECHO_MAX_CHARS): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[@`*_~|>\\]/g, "") // mention + markdown breakers
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars)
    .trim();
}

/** One rendered activity line, e.g. "reading irs.gov" (no arrow, no …). */
export type ActivityLine = string;

/**
 * Map a tool event (name + optional input) to an activity line.
 *   - mode "hold": the strict fixed phrase set, byte-identical to
 *     `toolStatusPhrase` (hold's invariant is unchanged).
 *   - mode "stream": hostname for fetches, sanitized query for searches,
 *     fixed phrases otherwise. Every fallback is the mode-appropriate
 *     fixed phrase — a malformed/hostile input can only ever degrade to
 *     the fixed phrase, never render raw.
 */
export function describeToolActivity(
  toolName: string,
  input: unknown,
  mode: "hold" | "stream",
): ActivityLine {
  if (mode === "hold") return toolStatusPhrase(toolName);
  const n = toolName.toLowerCase();
  const inputObj =
    input !== null && typeof input === "object"
      ? (input as Record<string, unknown>)
      : undefined;
  if (n.includes("webfetch") || n.includes("web_fetch")) {
    const rawUrl = inputObj?.url;
    if (typeof rawUrl === "string") {
      try {
        const host = sanitizeEcho(new URL(rawUrl).hostname.replace(/^www\./, ""));
        if (host.length > 0) return `reading ${host}`;
      } catch {
        // fall through to the fixed phrase
      }
    }
    return "reading a source";
  }
  if (
    n.includes("websearch") ||
    n.includes("web_search") ||
    n.includes("brave") ||
    n === "search" ||
    n.endsWith("__search")
  ) {
    const q = sanitizeEcho(inputObj?.query);
    return q.length > 0 ? `searching “${q}”` : "searching the web";
  }
  if (n.includes("finnhub")) {
    const sym = sanitizeEcho(inputObj?.symbol, 12).toUpperCase();
    return sym.length > 0 ? `checking market data for ${sym}` : "checking market data";
  }
  if (n.includes("ask_advisor") || n.includes("advisor")) {
    return "consulting the advisor";
  }
  // 999.151 (2026-09-17 operator screenshots) — the file/shell/plan tools are
  // most of a real turn and they ALL collapsed to "reviewing files" /
  // "running analysis" / "working": forty steps of status that never said what
  // the agent was doing. Same treatment Write/Edit already had — name the
  // thing. Every echoed fragment still goes through `sanitizeEcho`.
  if (n === "read") {
    const name = safeBasename(inputObj?.file_path);
    return name.length > 0 ? `reading ${name}` : "reviewing files";
  }
  if (n === "grep") {
    const pat = sanitizeEcho(inputObj?.pattern, TASK_ECHO_MAX_CHARS);
    if (pat.length === 0) return "searching files";
    const where = safeBasename(inputObj?.path);
    return where.length > 0
      ? `searching ${where} for “${pat}”`
      : `searching files for “${pat}”`;
  }
  if (n === "glob") {
    const pat = describePattern(inputObj?.pattern);
    return pat.length > 0 ? `looking for ${pat}` : "looking through files";
  }
  if (n === "ls") {
    const name = safeBasename(inputObj?.path);
    return name.length > 0 ? `listing ${name}` : "listing files";
  }
  if (n === "bash" || n === "bashoutput") {
    // The Bash tool carries its own human-written `description` ("Show working
    // tree status") — the best available one-line answer to "what is it doing?".
    const desc = sanitizeEcho(inputObj?.description, TASK_ECHO_MAX_CHARS);
    if (desc.length > 0) return lowerFirst(desc);
    // NEVER echo the command itself (`project_mcp_secrets_in_argv` — argv
    // carries tokens). The leading token is the program name and is enough.
    const raw = inputObj?.command;
    const head = typeof raw === "string" ? (raw.trim().split(/\s+/)[0] ?? "") : "";
    return /^[A-Za-z0-9._/-]{1,24}$/.test(head)
      ? `running ${safeBasename(head)}`
      : "running a command";
  }
  // 999.63d/5 — the previously-unmapped set. These are the agent's
  // LOAD-BEARING activities (authoring the client document, fanning out
  // reviewers), so the trail used to go generic exactly when the agent was
  // doing the most consequential thing (operator feedback 2026-08-26).
  if (n === "task" || n.includes("subagent") || n.includes("spawn_subagent")) {
    // `description` is the human-readable label; `subagent_type` is the
    // fallback when a caller omits it (spawn_subagent_thread has no
    // description field at all).
    const what =
      sanitizeEcho(inputObj?.description, TASK_ECHO_MAX_CHARS) ||
      sanitizeEcho(inputObj?.subagent_type, TASK_ECHO_MAX_CHARS);
    return what.length > 0 ? `delegating: ${what}` : "delegating to a reviewer";
  }
  if (n === "write") {
    const name = safeBasename(inputObj?.file_path);
    return name.length > 0 ? `writing ${name}` : "writing a document";
  }
  if (n === "edit" || n === "multiedit" || n === "notebookedit") {
    // NotebookEdit names its target `notebook_path`, not `file_path`.
    const name =
      safeBasename(inputObj?.file_path) || safeBasename(inputObj?.notebook_path);
    return name.length > 0 ? `editing ${name}` : "editing a document";
  }
  if (n === "todowrite") {
    // The plan the agent just wrote names the step it is on — strictly more
    // informative than "planning the work".
    const active = activeTodo(inputObj?.todos);
    return active.length > 0 ? lowerFirst(active) : "planning the work";
  }
  if (n === "skill") {
    const name = sanitizeEcho(inputObj?.skill, TASK_ECHO_MAX_CHARS);
    return name.length > 0 ? `using the ${name} skill` : "using a skill";
  }
  if (n.includes("memory")) {
    const q = sanitizeEcho(inputObj?.query, TASK_ECHO_MAX_CHARS);
    if (q.length > 0) return `recalling “${q}”`;
    return n.includes("save") || n.includes("write") || n.includes("edit")
      ? "saving to memory"
      : "searching memory";
  }
  // An MCP tool reads `mcp__<server>__<tool>`; both halves are operator
  // config (server registry) or SDK metadata, never model-generated. Rendering
  // them beats the bare "working" every MCP call used to collapse to.
  const mcp = splitMcpName(toolName);
  if (mcp !== null) return `${mcp.server} › ${mcp.tool}`;
  const humanized = humanizeToolName(toolName);
  return humanized.length > 0 ? `using ${humanized}` : "working";
}

/**
 * Trailing path segment only — never the directory chain. A client file
 * path can carry a household name; the BASENAME is what the operator
 * needs to recognise the document, and the parent directories are the
 * part that would leak workspace layout into a channel.
 */
function safeBasename(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const last = raw.split(/[\\/]/).filter((p) => p.length > 0).pop() ?? "";
  return sanitizeEcho(last, TASK_ECHO_MAX_CHARS);
}

/** Lowercase a leading capital so a tool `description` reads mid-sentence. */
function lowerFirst(s: string): string {
  return /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/**
 * A glob pattern with its wildcards spoken rather than printed: a
 * double-star ".ts" pattern reads as ".ts files".
 * `sanitizeEcho` strips `*` (it italicises in Discord), so the raw pattern
 * would otherwise arrive as a mangled "/.ts".
 */
function describePattern(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const bare = sanitizeEcho(
    raw.replace(/\*+/g, " ").replace(/[\\/]+/g, " "),
    TASK_ECHO_MAX_CHARS,
  ).trim();
  if (bare.length === 0) return "";
  return /^\.[A-Za-z0-9]+$/.test(bare) ? `${bare} files` : bare;
}

/** The step a TodoWrite plan is ON: in-progress first, else the next pending. */
function activeTodo(raw: unknown): string {
  if (!Array.isArray(raw)) return "";
  const at = (status: string): Record<string, unknown> | undefined =>
    raw.find(
      (t) => (t as { status?: unknown } | null)?.status === status,
    ) as Record<string, unknown> | undefined;
  const pick = at("in_progress") ?? at("pending");
  if (pick === undefined) return "";
  return sanitizeEcho(pick.activeForm ?? pick.content, TASK_ECHO_MAX_CHARS);
}

/** `mcp__finnhub__stock_candles` → `{ server: "finnhub", tool: "stock candles" }`. */
function splitMcpName(raw: string): { server: string; tool: string } | null {
  if (!raw.startsWith("mcp__")) return null;
  const parts = raw.slice("mcp__".length).split("__").filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  // Hyphens belong to a server's identity (`acme-db`, `example-tasks`);
  // only underscores are word separators.
  const server = sanitizeEcho(parts[0]!.replace(/_+/g, " "), 24);
  const tool = humanizeToolName(parts.slice(1).join(" "));
  return server.length > 0 && tool.length > 0 ? { server, tool } : null;
}

/** `post_cv2_embed` / `postCv2Embed` → `post cv2 embed`. */
function humanizeToolName(raw: string): string {
  const spaced = raw
    .replace(/^mcp__/, "")
    .replace(/__/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase();
  return sanitizeEcho(spaced, TASK_ECHO_MAX_CHARS);
}

/** Max completed lines shown above the current one. */
export const TRAIL_MAX_DONE_LINES = 3;

/** Echo cap for the detail carried by task / file / skill activities. */
export const TASK_ECHO_MAX_CHARS = 48;

/**
 * Fallback arming thresholds for a turn whose PROMPT did not read as a
 * financial topic. The topic gate reads the inbound prompt, but a turn
 * can acquire financial substance from the WORK rather than the ask —
 * the 2026-08-26 12-plan audit was prompted with no figure and no rule
 * term, yet its draft carried 17 financial tokens and the rules class
 * flagged `529 / 457(b) / penalty / age 65`. Under the topic gate alone
 * that turn would render NO trail, which is worse than the generic
 * "working…" it replaced. So a turn that goes quiet and tool-heavy arms
 * the trail on its own.
 */
export const TRAIL_QUIET_TOOL_THRESHOLD = 3;
export const TRAIL_QUIET_MS = 20_000;

/**
 * Decide whether a trail that was NOT armed by the prompt should arm
 * now. Pure so the thresholds are testable without a Discord client.
 */
export function shouldArmQuietTrail(
  toolEventCount: number,
  elapsedMs: number,
): boolean {
  return (
    toolEventCount >= TRAIL_QUIET_TOOL_THRESHOLD || elapsedMs >= TRAIL_QUIET_MS
  );
}

/**
 * Rolling activity trail for the streamStatus status message:
 *
 *   **Working · 12 steps · 2m**
 *   -# ✓ reading arielle-401k.pdf
 *   -# “Checking the plan file next”
 *   -# → running: diff the contribution limits…
 *
 * Tool events are STARTS only, so a new event promotes the previous
 * current line to ✓ — an honest approximation (the previous tool has
 * almost always resolved by the time the next one starts). Pure: caller
 * owns throttling and delivery.
 *
 * 999.151 (2026-09-17) — two changes from operator feedback on the live
 * cards. (1) No per-tool emoji: the card is a checklist, so ✓ for done and
 * → for current is the whole vocabulary ("I don't like all the icons
 * everywhere"). (2) An item carries its KIND: a narration fragment lifted
 * from the draft is the agent SPEAKING, not a completed step, and rendering
 * it as `✓ He deleted it` asserted something the agent never did.
 *
 * 999.171 — live thinking. `setThinking` shows `→ thinking · 2.4k tokens` as
 * the CURRENT line. A newer count replaces it in place, and the next tool
 * replaces it outright: thinking is never promoted to a ✓ done line, so a
 * think / tool / think turn never piles up "thinking" rows. A trail that
 * never receives a thinking event renders exactly as before.
 */
export class StatusTrail {
  private readonly done: TrailItem[] = [];
  private current: TrailItem | null = null;
  private sawThinking = false;

  /** True once any thinking progress was shown (latched; drives the header). */
  get thinkingSeen(): boolean {
    return this.sawThinking;
  }

  /**
   * Record an activity start. Returns false when it duplicates current.
   * The `thinking` kind is refused here — it enters only via setThinking.
   */
  push(line: ActivityLine, kind: TrailItemKind = "tool"): boolean {
    if (kind === "thinking") return false;
    if (line.length === 0 || line === this.current?.line) return false;
    // A live thinking line is REPLACED by the next activity, never kept.
    if (this.current !== null && this.current.kind !== "thinking") {
      this.promoteCurrent();
    }
    this.current = { line, kind };
    return true;
  }

  /**
   * 999.171 — show live thinking progress as the current line. Returns true
   * when the rendered trail changed. Rejects a non-finite or negative count.
   */
  setThinking(estimatedTokens: number): boolean {
    if (
      typeof estimatedTokens !== "number" ||
      !Number.isFinite(estimatedTokens) ||
      estimatedTokens < 0
    ) {
      return false;
    }
    const line = `thinking · ${formatThinkingTokens(estimatedTokens)}`;
    if (this.current?.kind === "thinking") {
      if (this.current.line === line) return false;
      this.current = { line, kind: "thinking" };
      return true;
    }
    if (this.current !== null) this.promoteCurrent();
    this.current = { line, kind: "thinking" };
    this.sawThinking = true;
    return true;
  }

  private promoteCurrent(): void {
    if (this.current === null) return;
    this.done.push(this.current);
    while (this.done.length > TRAIL_MAX_DONE_LINES) this.done.shift();
  }

  /** Composed slot-message body. Empty trail renders the bare header. */
  render(): string {
    const lines = ["working"];
    for (const d of this.done) lines.push(renderTrailItem(d, "done"));
    if (this.current !== null) lines.push(renderTrailItem(this.current, "current"));
    return lines.join("\n");
  }

  /**
   * 2026-08-27 — rendering for a DEDICATED status message
   * (`verification.ux.statusMessage: "separate"`). The shared-slot render
   * above has to look like a message that is about to BECOME the answer;
   * a standalone status card can be quieter and denser: a bold text header
   * over `-#` subtext lines (Discord renders those small and grey), each
   * item clipped to one tidy clause so a long narration fragment can't run
   * three lines wide on a phone.
   */
  renderSubtext(header = "Working"): string {
    const lines = [`**${header}**`];
    for (const d of this.done) lines.push(`-# ${renderTrailItem(d, "done")}`);
    if (this.current !== null) {
      lines.push(`-# ${renderTrailItem(this.current, "current")}`);
    }
    return lines.join("\n");
  }
}

/**
 * What a trail item IS. `tool` is work the agent did (✓ / →); `speech` is a
 * narration fragment diverted out of the draft, rendered as a quotation so it
 * can never read as a completed action. `thinking` (999.171) is live thinking
 * progress: always the CURRENT line, never in the done list.
 */
export type TrailItemKind = "tool" | "speech" | "thinking";

interface TrailItem {
  readonly line: ActivityLine;
  readonly kind: TrailItemKind;
}

function renderTrailItem(item: TrailItem, position: "done" | "current"): string {
  const text = clipItem(item.line);
  if (item.kind === "speech") return `“${text}”`;
  // No trailing ellipsis: the token count already reads as in-progress.
  if (item.kind === "thinking") return `→ ${text}`;
  return position === "done"
    ? prefixed(text, "✓")
    : `${prefixed(text, "→")}…`;
}

/**
 * 999.171 — token count for the thinking line. Rounded first; whole tokens
 * below 1000 ("1 token", "185 tokens"), otherwise one-decimal k
 * ("2.4k tokens"). Only this number ever renders from a thinking frame.
 */
export function formatThinkingTokens(n: number): string {
  const r = Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  if (r < 1000) return `${r} token${r === 1 ? "" : "s"}`;
  return `${(r / 1000).toFixed(1)}k tokens`;
}

/**
 * 999.171 — the status-trail header, extracted verbatim from the bridge's
 * paintTrail (claims, then steps, then the bare word, then `· elapsed`) plus
 * one new branch: a turn that has only thought so far reads "Thinking".
 * Pure: the caller measures elapsedMs.
 */
export function composeTrailHeader(input: {
  readonly claimCount: number;
  readonly toolCallsSeen: number;
  readonly thinkingSeen: boolean;
  readonly elapsedMs: number;
}): string {
  const { claimCount, toolCallsSeen, thinkingSeen, elapsedMs } = input;
  const elapsed = formatElapsed(elapsedMs);
  const head =
    claimCount > 0
      ? `Verifying · ${claimCount} claim${claimCount === 1 ? "" : "s"}`
      : toolCallsSeen > 0
        ? `Working · ${toolCallsSeen} step${toolCallsSeen === 1 ? "" : "s"}`
        : thinkingSeen
          ? "Thinking"
          : "Working";
  return elapsed.length > 0 ? `${head} · ${elapsed}` : head;
}

/**
 * 999.171 — first-paint floor for a THINKING-ONLY turn (no tool, no claim).
 *
 * The 2026-08-27 phantom-notification rule (pinned by
 * bridge-status-message.test.ts): a status message must never be posted and
 * then deleted moments later — Discord has already notified. So a turn that
 * has only thought stays silent until it has run this long. Once it has
 * painted, the message is kept and settles to `-# Thought for <elapsed>`
 * (operator decision 2026-09-24) instead of being deleted.
 *
 * Equal to the header's elapsed floor, so when the floor is met the header
 * already carries elapsed time. First-token p50 is 18-62 s, so a real think
 * still shows from about 5 s.
 */
export const THINKING_FIRST_PAINT_MIN_MS = ELAPSED_HEADER_FLOOR_SECS * 1000;

/** True once a thinking-only turn has run long enough to post its status. */
export function shouldPaintThinkingOnly(
  elapsedMs: number,
  minMs: number = THINKING_FIRST_PAINT_MIN_MS,
): boolean {
  return elapsedMs >= minMs;
}

/**
 * Prefix a status item unless it already carries its own verdict glyph — a
 * claim line arrives as `✓ <claim> · <host>`, and blindly prefixing produced
 * the `✓ ✓ Under current law RMDs begin…` double-tick the operator flagged.
 */
function prefixed(item: string, glyph: string): string {
  return /^[✓✏️?·→⚠️]/u.test(item) ? item : `${glyph} ${item}`;
}

/** Longest status item before it is clipped at a word boundary. */
export const TRAIL_ITEM_MAX_CHARS = 64;

/**
 * One tidy clause: drop a trailing sentence-ender, keep the FIRST sentence
 * when a fragment runs on ("A. Now B." → "A"), and clip at a word boundary.
 */
export function clipItem(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  const firstStop = s.search(/[.!?](\s|$)/);
  if (firstStop > 12) s = s.slice(0, firstStop);
  s = s.replace(/[.!?,;:\s]+$/, "");
  if (s.length <= TRAIL_ITEM_MAX_CHARS) return s;
  const cut = s.slice(0, TRAIL_ITEM_MAX_CHARS);
  const sp = cut.lastIndexOf(" ");
  return (sp > 24 ? cut.slice(0, sp) : cut).replace(/[.!?,;:\s]+$/, "");
}

/**
 * Remove the narration prefix already shown as status items.
 *
 * EXACT-PREFIX ONLY. The caller compares two different strings — the editor's
 * accumulated stream buffer and the dispatcher's final response — which can
 * diverge (model-Sources stripping, em-dash rewriting). A length-based slice
 * across them truncated a delivered answer mid-word. When `text` does not
 * literally start with `diverted`, nothing is stripped.
 */
export function stripDivertedNarration(text: string, diverted: string): string {
  if (diverted.length === 0) return text;
  if (!text.startsWith(diverted)) return text;
  return text.slice(diverted.length).replace(/^\s+/, "");
}
