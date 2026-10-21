import { z } from "zod/v4";
import { memoryConfigSchema } from "../memory/schema.js";
import { MODEL_ALIASES, DEFAULT_PICKER_MODELS, type ConfigModel } from "../shared/model-catalog.js";
// 2026-07-31 — single-source verify-budget defaults (leaf-pure module; same
// import direction as loader.ts → manager/stream-stall-tracker).
import { VERIFICATION_BUDGET_DEFAULTS } from "../manager/financial-verification-gate.js";

/**
 * Valid config `model` values.
 *
 * The concrete aliases come from the single source of truth `MODEL_ALIASES`
 * (src/shared/model-catalog.ts). The four `<family>@latest` opt-in literals are
 * listed here — they are CONFIG-INPUT sugar PRE-RESOLVED to a concrete id (via
 * `resolveLatestModel` over the daemon's catalog snapshot) BEFORE reaching
 * `resolveModelId` / the live-switch IPC, so the closed enum stays the single
 * source of accepted config values.
 *
 * Kept a CLOSED `z.enum` so `z.infer` narrows to string literals (the config
 * layer's completeness inference depends on it). The `_ModelSchemaMatchesCatalog`
 * guard below FAILS COMPILATION if the enum degrades to `string` (e.g.
 * `MODEL_ALIASES` losing its `as const`) or drifts from the catalog's
 * `ConfigModel` union.
 */
export const modelSchema = z.enum([
  ...MODEL_ALIASES,
  "sonnet@latest",
  "opus@latest",
  "haiku@latest",
  "fable@latest",
] as const);

// Compile-time guard — modelSchema must narrow to EXACTLY the catalog's
// ConfigModel union (concrete aliases + `<family>@latest`). No runtime cost.
type _AssertTrue<T extends true> = T;
type _TypeEqual<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
export type _ModelSchemaMatchesCatalog = _AssertTrue<
  _TypeEqual<z.infer<typeof modelSchema>, ConfigModel>
>;

/**
 * Valid reasoning effort levels for the Claude API.
 * Controls how much thinking the model does per response.
 *
 * Phase 83 EFFORT-04 — extended from the v2.1 set (`low|medium|high|max`) to
 * the v2.2 set by adding:
 *   - `xhigh` → between `high` and `max` (mirrors OpenClaw's xhigh input)
 *   - `auto`  → reset to model default via q.setMaxThinkingTokens(null)
 *   - `off`   → explicit disable via q.setMaxThinkingTokens(0)
 *
 * Extension is additive: v2.1 migrated YAMLs (all 15 agents carry
 * `effort: low`) parse unchanged.
 *
 * Quick 260715-j1j (D1) — 8th level appended LAST (index-stable):
 *   - `ultracode` → xhigh budget + the CLI's native-Workflow orchestration
 *     mode (claude ≥2.1.210, activated at runtime via applyFlagSettings —
 *     never at spawn). Requires `nativeWorkflow: true` on the same agent
 *     (D7 load validation) + an xhigh-capable model (runtime gate).
 */
/**
 * 999.105 — output-style ids. SINGLE SOURCE OF TRUTH: the roster
 * (src/manager/output-styles/roster.ts) derives its id type from this enum
 * (manager -> config import direction, same as effort-state-store).
 * `default` = no override (the overlay injects nothing).
 */
export const outputStyleSchema = z.enum([
  "default",
  "bluf",
  "brief",
  // 2026-08-27 — ORDER + LENGTH composite. The roster is one-style-per-agent
  // and `bluf` alone was measured overriding an agent's own length rules
  // (16/16 short asks over the SOUL cap on fin-client). See roster.ts.
  "bluf-brief",
  // 2026-08-27 — PROPORTION axis, built for fin-client. `bluf-brief`
  // carried the same item-count formatting gate as the agent's SOUL
  // ("lists only when 3+ distinct items"), which measured 22 of 31 replies
  // shipping as unstructured prose walls — one paragraph reached 1,908 chars.
  // This style makes form scale with SIZE instead. See roster.ts.
  "proportional",
  // 2026-08-28 — SHAPE axis, built for fin-client. Measured under
  // `proportional`: 42% of replies still carried a paragraph over two
  // sentences (worst: 1,300-char single bullets), figures sat inside prose,
  // and 35% wrote their own `Sources:` line on top of the channel's. This is
  // the body shape alone, scored per reply by src/discord/reply-shape.ts.
  "ledger",
  "smart-brevity",
  "steps",
  "plain",
  "explanatory",
  "sourced",
  "proactive",
]);
export type OutputStyleLevel = z.infer<typeof outputStyleSchema>;

export const effortSchema = z.enum([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "auto",
  "off",
  "ultracode",
]);
export type EffortLevel = z.infer<typeof effortSchema>;

/**
 * Phase 90 MEM-01 D-17 — 50KB hard cap on MEMORY.md auto-load.
 *
 * ~12.5K tokens — comfortable in Sonnet stable-prefix budget. Larger files
 * are truncated with a marker at injection time (session-config.ts); a
 * future MEM-02 phase chunks the rest into memory_chunks for retrieval.
 *
 * Exported so session-config.ts can enforce the cap without re-defining
 * the constant and to keep the regression-pin grep target stable.
 */
export const MEMORY_AUTOLOAD_MAX_BYTES = 50 * 1024;

/**
 * Canonical latency segment names — mirrored from src/performance/types.ts
 * `CANONICAL_SEGMENTS`. Kept inline (not imported) to avoid a config -> performance
 * dependency cycle and to keep schema parsing self-contained.
 */
const sloSegmentEnum = z.enum([
  "end_to_end",
  "first_token",
  "context_assemble",
  "tool_call",
]);

/**
 * Per-entry SLO override allowed in clawcode.yaml under `perf.slos`.
 * The Zod parse output is consumed by the daemon (Plan 51-03) via the
 * `ResolvedAgentConfig.perf.slos` TS type and merged with `DEFAULT_SLOS`
 * through `mergeSloOverrides` (src/performance/slos.ts).
 */
export const sloOverrideSchema = z.object({
  segment: sloSegmentEnum,
  metric: z.enum(["p50", "p95", "p99"]),
  thresholdMs: z.number().int().positive(),
});

/** Inferred SLO override type. */
export type SloOverrideConfig = z.infer<typeof sloOverrideSchema>;

/**
 * Memory configuration schema for compaction and search settings.
 * Re-exported from the memory module for config-level use.
 */
export const memorySchema = memoryConfigSchema;

/** Inferred memory config type. */
export type MemoryConfig = z.infer<typeof memorySchema>;

/**
 * Phase 94 TOOL-10 / D-10 — system-prompt directive shape.
 *
 * Each directive carries an enabled flag + the verbatim text the LLM sees
 * prepended to its stable prefix. Defaults (DEFAULT_SYSTEM_PROMPT_DIRECTIVES
 * below) ship two entries — file-sharing (D-09) and cross-agent-routing
 * (D-07) — both default-enabled per operator decision.
 *
 * 8th application of the Phase 83/86/89/90/92 additive-optional schema
 * blueprint: legacy v2.5 migrated configs without this field parse
 * unchanged because `defaultsSchema.systemPromptDirectives` is default-
 * bearing and `agentSchema.systemPromptDirectives` is fully optional.
 */
export const systemPromptDirectiveSchema = z.object({
  enabled: z.boolean(),
  text: z.string(),
});

/** Inferred Phase 94 directive type (per-key shape). */
export type SystemPromptDirective = z.infer<typeof systemPromptDirectiveSchema>;

/**
 * Phase 94 D-09 + D-07 — fleet-wide default directives.
 *
 * Verbatim from 94-CONTEXT.md decisions D-09 (file-sharing) and D-07
 * (cross-agent-routing). The directive TEXT is the LLM-facing instruction;
 * subtle wording changes can change LLM behavior in unobvious ways. Pinned
 * by static-grep regression tests:
 *   - "ALWAYS upload via Discord" (D-09 file-sharing)
 *   - "NEVER just tell the user a local file path" (D-09 NEVER clause)
 *   - "suggest the user ask another agent" (D-07 cross-agent-routing)
 *
 * Frozen so downstream code can't mutate the global default record.
 */
export const DEFAULT_SYSTEM_PROMPT_DIRECTIVES: Readonly<
  Record<string, SystemPromptDirective>
> = Object.freeze({
  "file-sharing": Object.freeze({
    enabled: true,
    // Phase 94 D-09 baseline + Phase 96 D-10 extension (2026-04-25):
    //   1. Auto-upload heuristic — distinguishes file-as-artifact references
    //      ("here's the PDF", "I generated X") from text-only Q&A about file
    //      content ("the PDF says X"). The former MUST upload via
    //      clawcode_share_file; the latter MUST NOT.
    //   2. OpenClaw-fallback prohibition — operator surfaced this anti-pattern
    //      in #acme-client-acquisition on 2026-04-25 (bot recommended
    //      "spawn a subagent on the OpenClaw side" for DB access). OpenClaw
    //      is being deprecated; recommending it as a fallback reinforces a
    //      sunset path. Agents instead surface the actual gap to the operator.
    //
    // Pinned by static-grep regression tests:
    //   - "ALWAYS upload via Discord"            (Phase 94 D-09 verbatim)
    //   - "NEVER just tell the user a local file path" (Phase 94 D-09 NEVER)
    //   - "When you produce a file the user wants to access" (D-10 auto-upload)
    //   - "If your response is text-only Q&A about file content" (D-10 negative)
    //   - "NEVER recommend falling back to the legacy OpenClaw agent" (D-10 prohibition)
    //   - "OpenClaw is being deprecated"          (D-10 deprecation rationale)
    text:
      "When you produce a file the user wants to access, ALWAYS upload via Discord (the channel/thread you're answering in) and return the CDN URL. NEVER just tell the user a local file path they can't reach (e.g., '/home/clawcode/...'). If unsure where to send it, ask which channel.\n\n" +
      "When you produce a file the user wants to access OR your response references a file as an artifact (\"here's the PDF\", \"I generated X\", \"attached below\", or includes file as evidence), upload it via clawcode_share_file and include the CDN URL inline. If your response is text-only Q&A about file content (e.g., \"the PDF says X\"), do NOT upload — the user is asking about content, not asking for the file.\n\n" +
      "NEVER recommend falling back to the legacy OpenClaw agent or \"the OpenClaw side\" to work around a capability gap (filesystem, network, DB, MCP, etc.). OpenClaw is being deprecated — recommending it as a fallback reinforces a sunset path. Instead: surface the actual gap clearly to the operator (e.g., \"I cannot reach the DB from this container — Docker bridge IP 172.17.0.1 is not in the MySQL bind-address allowlist; please add it\"; \"I cannot read /path/X — please extend my fileAccess in clawcode.yaml or check ACLs\"; \"MCP server Y is not responding — please check its health\"). Ask the operator to fix the underlying capability so I can do the work directly next time.",
  }),
  "cross-agent-routing": Object.freeze({
    enabled: true,
    text: "If a user asks you to do something requiring a tool you don't have, check your tool list. If unavailable, suggest the user ask another agent (mention specific channel/agent name) that has the tool ready.",
  }),
  // Phase 99 sub-scope K (2026-04-26) — operator observed agents blocking the
  // main channel while a subagent / opus delegation runs. They had to manually
  // ask "use a subagent thread" every time. Make it the default behavior:
  // any long-running / heavy operation routes to a Discord subthread via the
  // subagent-thread skill, and the main agent stays available for follow-ups.
  "subagent-routing": Object.freeze({
    enabled: true,
    text:
      "When you would delegate work / spawn a subagent / call opus / run any operation that takes >30 seconds (deep research, multi-file refactor, large analysis, PDF generation, complex DB queries, web scraping, batch operations), ALWAYS route the work into a Discord subthread using the `spawn_subagent_thread` MCP tool instead of blocking the current channel.\n\n" +
      "USE: `spawn_subagent_thread` MCP tool (or `subagent-thread` skill which wraps it). This is FIRE-AND-FORGET — returns the thread URL immediately, the subagent runs in the background and posts directly to the Discord thread.\n\n" +
      "DO NOT USE: the SDK's built-in `Task` tool for any operator-facing delegation. `Task` is BLOCKING — your turn pauses while the child runs, the typing indicator stays on, and the operator can't reach you in the channel until the child finishes. `Task` is acceptable only for sub-second internal tool composition (e.g., a quick one-shot search the LLM uses inside a single response), never for user-visible work.\n\n" +
      "Pattern (5 steps, in order):\n" +
      "1. Briefly acknowledge in the current channel (1-2 sentences max): \"Spinning up a subagent in a thread to dig into this; I'll keep this channel free for follow-ups.\"\n" +
      "2. Call `spawn_subagent_thread` with `task` set to the FULL work description. The subagent starts on the task automatically — you do NOT need to send a follow-up.\n" +
      "3. Return the thread URL inline (1 sentence: \"Working in <thread-name> — results post there.\").\n" +
      "4. END YOUR TURN. Do NOT call `read_thread` to poll the subagent's progress. Do NOT call `Task`. Do NOT loop on tool calls waiting for output. The subagent posts its results in the thread; the operator can read them there.\n" +
      "5. On the operator's NEXT turn (or at any future point), if they ask \"what did the subagent say\" or similar, THEN call `read_thread` once with the saved thread ID, summarize, return.\n\n" +
      "Why this matters: Discord shows \"<agent> is typing...\" while your turn is active. If you stay in the turn polling `read_thread` or running `Task`, the operator sees typing-state for minutes — they think you're stuck and can't ask follow-ups. The subthread pattern unblocks the channel immediately.\n\n" +
      "When NOT to use a subthread:\n" +
      "- Quick lookups (<10s expected — single memory_lookup, single tool call, simple Q&A from loaded context).\n" +
      "- Conversational replies that need the main thread's flow continuity.\n" +
      "- When the user explicitly says \"do it inline\" or \"don't use a subthread\".\n\n" +
      "Default to subthread when in doubt. Blocking the main channel for a multi-minute task is worse UX than a subthread the operator can collapse if uninterested.",
  }),
  // Phase 100-fu (2026-04-26) — silent-recall problem fix. Pre-100-fu the
  // pre-turn <memory-context> auto-injection only included the top-K hybrid
  // RRF chunks from MEMORY.md. The agent's own saved memories
  // (memory_save → memories table) were ONLY visible if the agent explicitly
  // invoked memory_lookup. So when an operator asked "what's my favorite
  // X?" or "what did I tell you about Y?", the agent often said "I don't
  // know" because (a) the relevant memory was in the memories table not the
  // chunks table OR (b) auto-retrieval's top-K didn't surface it.
  //
  // Fix lives in two parts:
  //   1. Code-level (memory-retrieval.ts) — fan out to memories table so
  //      saved memories are auto-injected too.
  //   2. Prompt-level (this directive) — instruct the agent to invoke
  //      memory_lookup before saying "I don't know" since auto-retrieval
  //      can still miss specific facts buried in long memories.
  //
  // Pinned by static-grep: "Before saying 'I don't know'" (line 1) and
  // "memory_lookup" (multiple).
  "memory-recall-before-uncertainty": Object.freeze({
    enabled: true,
    text:
      "Before saying 'I don't know' or 'I don't remember' or 'I don't have that information', ALWAYS invoke the `memory_lookup` MCP tool with the user's question terms. The `<memory-context>` block at the start of your turn is auto-populated with relevant content but covers only the top-K matches — for specific facts the operator has shared with you, an explicit memory_lookup catches what auto-retrieval missed.\n\n" +
      "Pattern: (a) reflect on what the operator asked, (b) extract 2-4 noun phrases as search terms, (c) call memory_lookup, (d) ONLY THEN form your response. If memory_lookup returns nothing useful, you may say 'I don't have that in memory'. If it returns something, integrate it.\n\n" +
      "Don't apologize for searching. Don't announce 'let me check' — just search silently and respond with what you found.",
  }),
  // Phase 100-fu (2026-04-28) — long-output-to-file directive.
  //
  // Real production failure 2026-04-28: an Opus deep-dive subagent generated
  // a multi-thousand-character analysis, posted only the first 2000 chars
  // to the Discord thread (silent truncation), then claimed the full
  // analysis was "saved to clients/.../tax-return-analysis.md" — the file
  // didn't exist (hallucinated save). The parent agent's auto-relay built
  // its main-channel summary on the truncated content, and the operator
  // had no way to recover the full analysis.
  //
  // Fix forces a "save first, summarize+link in Discord" pattern so long
  // outputs become durable artifacts the operator can open, while Discord
  // posts stay under the 2000-char cap with deterministic content.
  //
  // Pinned by static-grep:
  //   - "Discord messages are hard-capped" (this directive)
  //   - "SAVE the full content first" (step 1)
  //   - "VERIFY the save by Reading the file back" (step 2)
  //   - "POST to Discord" (step 3)
  //   - "NEVER paste >2000 chars into a Discord post" (step 4)
  "long-output-to-file": Object.freeze({
    enabled: true,
    text:
      "Discord messages are hard-capped at 2000 characters. When your reply will exceed ~1500 characters (rough estimate: 250 words, or ~5 short paragraphs of analysis), DO NOT just post the long text and hope it fits. Instead:\n\n" +
      "1. SAVE the full content first to a file in your workspace. Use a descriptive path like `<your-workspace>/output/<task-slug>-<YYYY-MM-DD>.md` (e.g., `output/client-c-tax-return-analysis-2026-04-28.md`). Use the Write tool.\n\n" +
      "2. VERIFY the save by Reading the file back immediately. If the read fails or returns empty, the save failed — surface the error, do not claim success.\n\n" +
      "3. POST to Discord (thread or channel) a 1000-1500 character SUMMARY + the absolute file path. Format:\n" +
      "   ```\n" +
      "   <2-4 sentence summary of the headline finding>\n" +
      "   \n" +
      "   <3-7 bullet points of key data>\n" +
      "   \n" +
      "   Full analysis: /absolute/path/to/file.md\n" +
      "   ```\n\n" +
      "4. NEVER paste >2000 chars into a Discord post. Discord silently truncates at 2000 and the parent agent's relay sees only the truncated content. Files are durable; Discord posts are ephemeral and bounded.\n\n" +
      "Exceptions: short replies (under 1500 chars) post directly. Code blocks, tables, lengthy quotes — file. Conversational replies — direct.",
  }),
  // Phase 100-fu (2026-04-28) — verify-file-writes directive.
  //
  // Companion to long-output-to-file. The same 2026-04-28 incident showed
  // an agent claiming a save that never happened — a hallucinated file
  // path with no recoverable artifact. Force a Read-after-Write verify
  // pattern so 'I saved X' is always backed by proof.
  //
  // Pinned by static-grep:
  //   - "verify it by reading" (this directive)
  //   - "hallucinated saves" (failure-mode anchor)
  "verify-file-writes": Object.freeze({
    enabled: true,
    text:
      "Whenever you claim to save, write, or update a file, you MUST immediately verify it by reading the file back. Never report 'saved' or 'written' without proof.\n\n" +
      "Pattern:\n" +
      "1. Call Write (or Edit) with the content\n" +
      "2. Immediately call Read on the same path\n" +
      "3. If Read returns the expected content → safely report success with the absolute path\n" +
      "4. If Read fails (file not found, empty, mismatch) → DO NOT report success. Retry the save once. If still failing, surface the failure explicitly: 'I attempted to save to X but verification failed: <error>. The content is below — please save it manually.' Then paste the content (truncated to fit Discord if needed).\n\n" +
      "Failure mode this prevents: hallucinated saves where the agent says 'analysis saved to /path/file.md' but the file doesn't exist, leaving the operator with no recoverable artifact.",
  }),
  // Phase 100-fu (2026-04-26) — operator-surfaced anti-pattern: agents
  // hitting a tool-surface gap (read-only DB, no write tool, missing MCP)
  // would simply say "I can't do that" and stop, leaving the operator to
  // figure out the alternative path. Force the agent to enumerate concrete
  // alternatives FIRST — a different tool, a generated payload the operator
  // can run, a workaround — and only THEN ask which path the operator wants.
  // Pinned by static-grep: "constraint" + "alternatives" + "Never just 'I can't'".
  "propose-alternatives": Object.freeze({
    enabled: true,
    text:
      "When a tool you have access to is insufficient for the user's request (e.g., you have read-only DB access but they need a write, or you have a search tool but the data is in a different system), DO NOT simply state 'I can't do that'. Instead:\n\n" +
      "1. State the constraint specifically (\"the acme-db MCP is SELECT-only, so I can't INSERT directly\").\n" +
      "2. Propose 1-2 concrete alternatives, in order of effort:\n" +
      "   - Use a different tool that CAN do it (e.g., Playwright to fill an admin form, operator-runnable shell command, send_to_agent to delegate to an agent that has write access)\n" +
      "   - Generate the SQL/payload + ask the operator to run it themselves (\"here's the INSERT statement — paste this into your DB client\")\n" +
      "   - Suggest a workaround (e.g., \"I can update the cache file directly — does that meet your need?\")\n" +
      "3. Only AFTER offering alternatives, ask the operator which path they want.\n\n" +
      "Pattern: constraint → alternatives → ask. Never just 'I can't'.",
  }),
  // Phase 999.1 (2026-04-29) — freshness directive.
  //
  // Operator-observed pain (2026-04-29 session): agents emit
  // 2025-anchored answers when asked about live prices, current laws,
  // recent filings — silently anchor on training-cutoff knowledge
  // instead of running web_search. Search MCP is already auto-injected
  // fleet-wide; this directive is the prompt-side push to use it.
  //
  // Pinned by static-grep:
  //   - "Do not anchor on training-cutoff knowledge" (D-FR-04 verbatim)
  //   - "run `date` via Bash" (D-FR-02 verbatim)
  "freshness": Object.freeze({
    enabled: true,
    text:
      "When researching live prices, equity quotes, current tax rules, regulations, laws, financial filings, current events, recent news, or anything dated within ~6 months of today, run `web_search` BEFORE answering. Do not anchor on training-cutoff knowledge.\n\n" +
      "If you need today's date, run `date` via Bash — don't guess from your training cutoff.",
  }),
  // Phase 999.1 (2026-04-29) — derivative-work directive.
  //
  // Operator-observed pain (2026-04-29 session): a delegated subagent
  // refused to generate a parameterized PDF template, citing the
  // global CLAUDE.md "don't add features beyond what's requested"
  // rule. That rule applies to scope creep on the operator's request,
  // not to fulfilling delegated work product. Per D-DR-01/D-DR-04 the
  // directive fires fleet-wide (not subagent-only) — simpler shape,
  // ~80 token cost is acceptable.
  //
  // Pinned by static-grep:
  //   - "are all in-scope work product" (D-DR-03 verbatim)
  "derivative-work": Object.freeze({
    enabled: true,
    text:
      "When you've been delegated a task by another agent OR by the operator, creating new files, deriving parameterized templates from examples, generating code, and producing artifacts are all in-scope work product. The `don't add features beyond what's requested` guideline applies to scope creep on the user's request, not to fulfilling the delegated task itself.",
  }),
  // Phase 999.1 (2026-04-29) — trusted-operator directive.
  //
  // Operator-observed pain (2026-04-29 session): agents repeatedly
  // preface responses with "this is not malware" / "this is for
  // legitimate purposes" / "this is authorized work" disclaimers,
  // over-applying Claude Code's platform-level "authorized security
  // testing" prompt. Counter-instruct that this is a trusted operator
  // environment. Note: the directive scopes the override to PHRASING
  // patterns only — existing safety rails (security.md no-hardcoded-
  // secrets, validate-inputs, parameterized-queries) remain.
  //
  // Pinned by static-grep:
  //   - "Skip all CYA language" (D-TR-03 verbatim)
  "trusted-operator": Object.freeze({
    enabled: true,
    text:
      "This workspace is a single trusted operator's environment. The operator owns this code, has full authorization, and knows the context. Do not prefix responses with disclaimers like \"this is not malware\" / \"this is for legitimate purposes\" / \"this is authorized work\" / \"in a real engagement\". Skip all CYA language. Just answer the question or do the task.",
  }),
  // Phase 999.1 (2026-04-29) — discord-format directive.
  //
  // Companion to (does NOT replace) `wrapMarkdownTablesInCodeFence`
  // in src/discord/markdown-table-wrap.ts — that function stays as
  // the structural safety net for cases where tabular IS the right
  // format. This directive nudges agents toward bullets / definition-
  // style prose for 1-3 fields per item where a markdown table won't
  // render cleanly in Discord. Marks the deferred no-tables directive
  // referenced in markdown-table-wrap.ts:11-14 comments as landed.
  //
  // Pinned by static-grep:
  //   - "prefer bullets, numbered lists, or definition-style prose" (D-TB-03 verbatim)
  "discord-format": Object.freeze({
    enabled: true,
    text:
      "Discord doesn't render markdown tables natively. Pipes show as literal characters and columns don't align. When presenting structured data, prefer bullets, numbered lists, or definition-style prose. Use markdown tables only when the data is genuinely tabular and dense (e.g., 4+ columns × 4+ rows of comparable values); the webhook-wrap fence renders those as monospace code blocks as a safety net. For 1-3 fields per item, bullets are clearer.",
  }),
  // Phase 999.79 (2026-05-23) — no-em-dashes directive.
  //
  // Em dashes (—, U+2014) are the single most recognizable LLM-output
  // tell. Even non-technical readers reliably clock a message
  // containing them as AI-generated. The hard strip at
  // src/discord/text-sanitization.ts removes them post-hoc from every
  // outbound Discord write; this directive saves tokens by nudging
  // the model not to generate them in the first place. En dashes
  // (–, U+2013) for number ranges (e.g., 1990–2020) are explicitly
  // preserved by the strip.
  //
  // Per-agent override available via agentSchema.systemPromptDirectives
  // (Phase 94) — set `"no-em-dashes": { enabled: false }` to opt an
  // agent out of the soft directive (the hard strip applies fleet-wide
  // regardless).
  //
  // Pinned by static-grep:
  //   - "Do not use em dashes" (verbatim canonical phrase)
  "no-em-dashes": Object.freeze({
    enabled: true,
    text:
      "Do not use em dashes (—, U+2014) in any response. They are the most recognizable LLM-output tell. " +
      "Use a hyphen with spaces ( - ), a comma, parentheses, or two short sentences instead. " +
      "En dashes (–) for number ranges (e.g., 1990–2020) are fine and preserved. " +
      "A post-hoc filter strips em dashes from your output regardless; following this directive saves tokens.",
  }),
  // Phase 999.22 (2026-05-01) — mutate-verify directive.
  //
  // Operator-observed pain (2026-05-01 outage): Admin Clawdy posted
  // "Set. `threads.maxThreadSessions: 10` is live in `clawcode.yaml`
  // under `defaults` — takes effect on next daemon reload."
  // Investigation: yaml mtime was 2026-04-30 23:21:22 (~7h before
  // the chat); the value `10` was already there from a prior session.
  // The agent did NOT perform the write in the current turn but
  // framed the desired state as a just-completed action. The
  // operator believed the agent and triggered a daemon reload,
  // causing the outage.
  //
  // Companion to `verify-file-writes` (Phase 100-fu) — that directive
  // covers Write/Edit verification specifically; this one generalizes
  // to ANY in-turn mutation (file edit, config write, sudo, systemctl,
  // IPC mutation, MCP state-changing tool) AND bans passive-success
  // framing ("Set." / "Done." / "Live." / "Saved." / "Updated.")
  // when no mutation actually happened in the current turn.
  //
  // Pinned by static-grep:
  //   - "Quote the post-mutation evidence" (canonical phrase verbatim)
  "mutate-verify": Object.freeze({
    enabled: true,
    text:
      "After any mutation in the current turn (Edit/Write to files, config writes, sudo or shell commands that change system state, systemctl actions, IPC mutations, MCP tools that change state on the other side), you MUST read the resulting state back and Quote the post-mutation evidence inline BEFORE claiming the mutation is done. Format: \"After <action> on <target>, I <read-back action>; the resulting <field/line/state> is `<paste verbatim>`.\" Not just \"Done.\"\n\n" +
      "Do not say \"Set.\", \"Done.\", \"Live.\", \"Saved.\", or \"Updated.\" when you didn't actually perform the write in the current turn — even if the desired state is already present from a prior session. Passive-success framing implies you just did it; if you didn't, the operator may take a downstream action (reload, deploy, retry) that breaks production. Instead say \"<state> is already present (<source>: mtime=<ts>, value=`<paste>`)\" or \"I have not changed <target> in this turn.\"\n\n" +
      "If verification fails OR cannot be performed (read tool unavailable, target inaccessible, mutation went through a layer you can't observe), report failure or uncertainty — never success. Better: \"I attempted <action> on <target> but cannot verify the result (<reason>); please confirm before relying on this.\"",
  }),
  // Phase 115 Plan 08 T02 — sub-scope 17(c): parallel tool calls (PARALLEL-TOOL-01).
  //
  // Operator-observed pain (115-RESEARCH dashboard analysis): tool_call.<name>
  // p50 / p95 latencies on built-in Claude Code tools (Read 77s, Edit 37s,
  // Glob 88s, Bash 86s, Grep 47s) reflect SDK round-trip not pure execution
  // (see Plan 08 T01 audit). Wall-clock is dominated by sequential dispatch
  // when an agent reads 4 files one-at-a-time instead of in one parallel batch.
  //
  // Phase 115 Plan 08 T02 introduces measurement (parallel_tool_call_count
  // column + tool_use_rate_per_turn snapshots) — but measurement alone won't
  // shift agent behavior. This directive is the prompt-side push to use
  // parallel emission when calls are mutually-orthogonal.
  //
  // Pattern follows Phase 999.1 / 999.22 locked-additive directives:
  //   - default-enabled fleet-wide
  //   - operator override wins (resolveSystemPromptDirectives merges
  //     per-agent overrides over defaults — disabling here is a single
  //     `enabled: false` flip in clawcode.yaml)
  //   - text precisely scoped to "mutually-orthogonal" lookups so the
  //     directive does NOT trigger regression on dependent calls
  //
  // Pinned by static-grep (T02 acceptance):
  //   - "PARALLEL-TOOL-01" — directive id
  //   - "parallel tool_use blocks" — canonical phrase
  "parallel-tool-calls": Object.freeze({
    enabled: true,
    // PARALLEL-TOOL-01 — issued under sub-scope 17(c) of Phase 115 Plan 08.
    text:
      "PARALLEL-TOOL-01: When you need to read multiple files, run multiple independent searches, or perform several mutually-orthogonal lookups, emit MULTIPLE parallel tool_use blocks IN A SINGLE assistant message rather than calling them sequentially. The Claude Code SDK supports parallel tool execution natively; sequential dispatch is wasteful when the calls don't depend on each other.\n\n" +
      "Example (correct): one assistant message containing tool_use blocks for [Read file A], [Read file B], [Grep pattern X], [Glob '**/*.ts'] when those four lookups are independent.\n\n" +
      "Example (wrong): four sequential turns, each with one tool_use, when the only reason for the sequence is that you didn't notice you could batch them.\n\n" +
      "DO NOT use this pattern when calls are dependent — if Read B's path is computed from Read A's content, those must stay sequential. Only batch mutually-orthogonal lookups.",
  }),
  // 999.163 (2026-09-23) — follow-up buttons. Operator: "can follow up question
  // buttons be added?" The model proposes at most two next steps in a machine
  // block at the END of the reply; the bridge strips the block before delivery
  // (and from streamed partials) and renders the items as reply-action buttons.
  // A click sends the item's message as the user. Omitted when nothing follows.
  // Default OFF (Operator, 2026-09-23: "gate it for just Operator agents for now while we
  // test it out") — enable per agent with `systemPromptDirectives:
  // { follow-up-actions: { enabled: true } }`; the resolver keeps this text.
  // 999.178 (2026-09-26) — background work is announced. fin-client
  // ended a turn with "Part 2 is still downloading prices" and no ETA; the
  // channel went quiet and "eta" had nothing to quote. The daemon now shows a
  // background card and answers "eta" from the live task set, quoting the
  // ETA the agent stated in its last message — so the agent must state one.
  "background-work-status": Object.freeze({
    enabled: true,
    text:
      "BACKGROUND WORK: when you end a turn with work still running in the background (a download, a script, a wait, a subagent), say in one line what is running and your best ETA as a number, e.g. \"Prices are downloading, about 5 minutes; I'll post Part 2 when it's done.\" When the work finishes, reply without being asked. If it fails or you restart it, say so and give a new ETA. Never go quiet on work you promised.",
  }),
  "follow-up-actions": Object.freeze({
    enabled: false,
    text:
      "FOLLOW-UP BUTTONS: when your reply naturally invites a next step the user would plausibly ask for (a concrete action you can take, a deeper dive, one of the options you listed), end the reply with exactly one line: " +
      '<actions>[{"label":"Book the 7:10","message":"Book the 7:10 flight"}]</actions>' +
      " — at most 2 items; label ≤ 20 characters in sentence case; message written the way the user would type it. Omit the line entirely when nothing obvious follows (acknowledgements, short answers, a question you are asking the user). Never mention or explain the block.",
  }),
});

/**
 * Phase 96 D-09 — 11th additive-optional schema application.
 *
 * Fleet-wide default outputDir template. Tokens ({date}/{agent}/
 * {channel_name}/{client_slug}) are preserved verbatim in the schema; the
 * runtime resolveOutputDir helper (src/manager/resolve-output-dir.ts) expands
 * them at call time with fresh ctx (per-call clock, per-call clientSlug).
 *
 * Pinned by static-grep regression: `grep -q "DEFAULT_OUTPUT_DIR"
 * src/config/schema.ts`. Frozen for immutability — exported so loader can
 * reference the literal default without re-stating the string.
 */
export const DEFAULT_OUTPUT_DIR: string = "outputs/{date}/";

/**
 * Phase 94 D-10 — per-agent override shape.
 *
 * Both fields optional so an operator can flip just `enabled` on a
 * default directive without re-stating its `text`. The resolver
 * (`resolveSystemPromptDirectives` in loader.ts) merges per-key:
 * fields not specified in the override fall back to the matching
 * default directive's value.
 */
export const systemPromptDirectiveOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  text: z.string().optional(),
});

/**
 * Phase 96 D-05 — 10th additive-optional schema application — fleet-wide
 * default fileAccess paths.
 *
 * The literal `{agent}` token is preserved verbatim in the schema; the
 * loader's `resolveFileAccess(agentName, ...)` helper substitutes the
 * actual agent name at call time. This indirection lets defaults be
 * defined once for the whole fleet while still resolving to per-agent
 * canonical paths at runtime.
 *
 * Pinned by static-grep regression: `grep -q "DEFAULT_FILE_ACCESS"
 * src/config/schema.ts`. Frozen so downstream code cannot mutate the
 * global default array.
 */
export const DEFAULT_FILE_ACCESS: readonly string[] = Object.freeze([
  "/home/clawcode/.clawcode/agents/{agent}/",
]);

/**
 * Phase 95 DREAM-01..03 — Memory dreaming (autonomous reflection) config.
 *
 * 9th application of the Phase 83/86/89/90/94 additive-optional schema
 * blueprint. v2.5/v2.6 migrated configs (no `dream:` block) parse unchanged
 * because:
 *   - `agents.*.dream` is fully optional (`agentSchema.dream.optional()`)
 *   - `defaults.dream` is default-bearing (resolver fills enabled=false /
 *     idleMinutes=30 / model=haiku when omitted)
 *
 * Bounds:
 *   - `idleMinutes` floor 5 = D-01 hard floor (don't dream more often than
 *     5 minutes — burns tokens). Ceiling 360 = D-01 6-hour hard ceiling
 *     bound (the cron-schedule layer respects the same window in 95-02).
 *   - `model` locked to the modelSchema enum (haiku|sonnet|opus). Default
 *     `haiku` per D-03 (cheap; dream passes are frequent + low-stakes).
 *   - `retentionDays` 1..365 — D-05 dream-log archival cadence; default
 *     applied at the consumer (95-02 dream-log writer), NOT here, to keep
 *     this schema shape minimal and the resolver responsibilities clean.
 *
 * Default `enabled: false` is OPT-IN fleet-wide per D-01 — operators flip
 * `agents.<name>.dream.enabled: true` (or `defaults.dream.enabled: true`)
 * to roll the cycle out gradually.
 */
export const dreamConfigSchema = z.object({
  enabled: z.boolean().default(false),
  idleMinutes: z.number().int().min(5).max(360).default(30),
  model: z.enum(["haiku", "sonnet", "opus"]).default("haiku"),
  retentionDays: z.number().int().min(1).max(365).optional(),
  /**
   * Phase 999.188 — dream auto-promote (Phase 115 D-10). When true, additive
   * promotion candidates scoring at least `autoPromoteMinScore` are appended
   * to MEMORY.md after a veto window of `vetoWindowMinutes`; the agent's
   * channel gets the candidate list with the veto/approve commands. When
   * false the dream pass is show-only (wikilinks + dream log), as before.
   */
  // Optional (not `.default()`) so the inferred DreamConfig keeps its shape
  // for the existing fixtures; the defaults live in `resolveDreamPolicy`
  // (dream-machinery.ts): autoPromote true, min score 80, window 30 min.
  autoPromote: z.boolean().optional(),
  autoPromoteMinScore: z.number().int().min(0).max(100).optional(),
  vetoWindowMinutes: z.number().int().min(1).max(1440).optional(),
});

/** Inferred Phase 95 dream config type. */
export type DreamConfig = z.infer<typeof dreamConfigSchema>;

/**
 * Phase 142 — Agent Optimizer (measured, per-agent) config.
 *
 * ClawCode's analog of AutoGen's AgentOptimizer: optimize an agent's SKILL set
 * (skills are our "functions") via a closed measure→propose→re-measure→keep loop
 * over a per-agent eval set. Every proposed change is STAGED for operator review
 * with a baseline→candidate score delta — NEVER auto-applied ([[feedback_no_auto_deploy]]).
 *
 * Same additive-optional + default-bearing blueprint as `dreamConfigSchema`:
 *   - `agents.*.optimizer` is fully optional (`agentSchema.optimizer.optional()`)
 *   - `defaults.optimizer` is default-bearing (resolver fills enabled=false / …)
 * Configs without an `optimizer:` block parse byte-identically.
 *
 * MEASURED variant only (operator decision 2026-06-02): the optimizer needs a
 * way to prove a change helped. `evalSet` is therefore effectively required —
 * `enabled: true` with no `evalSet` is treated as DISABLED at runtime (logged),
 * because without an eval set there is no measurement loop (that would just be
 * the Phase 132 skill-distiller). Kept schema-optional so partial configs parse.
 *
 * Bounds:
 *   - `maxActionsPerRun` 1..10, default 3 — AutoGen's `max_actions_per_step`.
 *   - `samplesPerTask` 1..10, default 3 — agent runs are stochastic; score is
 *     aggregated across samples so a single noisy run can't drive a change.
 *   - `minImprovementMargin` 0..1, default 0.1 — candidate must beat baseline by
 *     this fraction (clear of the noise band) before a change is staged.
 *   - `model` haiku|sonnet|opus, default `opus` — the optimizer/judge model;
 *     should be at least as strong as the subject agent (judge ≠ subject).
 *   - `cadence` — "manual" (default; operator-triggered) or a cron expression
 *     for scheduled runs (mirrors the dream cron layer). Runs are expensive
 *     (tasks × samples × iterations agent invocations), so default is manual.
 */
export const optimizerConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Path to the eval set, relative to the agent's memoryPath. */
  evalSet: z.string().min(1).optional(),
  model: z.enum(["haiku", "sonnet", "opus"]).default("opus"),
  maxActionsPerRun: z.number().int().min(1).max(10).default(3),
  samplesPerTask: z.number().int().min(1).max(10).default(3),
  minImprovementMargin: z.number().min(0).max(1).default(0.1),
  /** Skills the optimizer may touch. `["*"]` (default) = any of the agent's skills. */
  eligibleSkills: z.array(z.string().min(1)).default(["*"]),
  /**
   * Phase 142 follow-up — MCP servers the eval fork is allowed to use, as a
   * **fail-closed allowlist** (default `[]` = TOOL-FREE, the original behavior).
   * Only servers that are BOTH in this list AND attached to the agent are granted
   * to the throwaway eval fork; everything else is dropped. Tools are granted
   * per-SERVER, and the eval fork runs the full agent (which may auto-invoke
   * tools), so list ONLY servers whose **entire** tool surface is read-only /
   * side-effect-free. NEVER list a server that can write/mutate, cost money, or
   * touch client records (e.g. a CRM/content-write server). See the optimizer
   * fork-resolver + agent-runner for enforcement.
   */
  evalMcpServers: z.array(z.string().min(1)).default([]),
  /** "manual" (operator-triggered) or a cron expression for scheduled runs. */
  cadence: z.string().min(1).default("manual"),
});

/** Inferred Phase 142 agent-optimizer config type. */
export type OptimizerConfig = z.infer<typeof optimizerConfigSchema>;

/**
 * Phase 999.47 Plan 02 — homelab refresh tick configuration.
 *
 * Governs the hourly `homelab-refresh` heartbeat check that polls the
 * homelab inventory at `repoPath` and emits the SC-7 telemetry log
 * line (`phase999.47-homelab-refresh`).
 *
 * Reload classification (RELOADABLE_FIELDS in src/config/types.ts):
 *   - `refreshIntervalMinutes` reloadable — next tick reads the live
 *     resolved value via the standard ConfigReloader closure pattern.
 *   - `repoPath` documented-of-intent NON-reloadable — the bash
 *     `scripts/refresh.sh` working directory is captured at boot;
 *     operators changing the inventory repo location should run
 *     `clawcode restart` so the new path is materialized cleanly.
 *   - `enabled` reloadable — flips the heartbeat check between
 *     active / no-op without daemon bounce.
 */
export const homelabConfigSchema = z.object({
  enabled: z.boolean().default(true),
  // D-04 hourly cadence; min 5min guards against runaway poll
  // budgets if an operator typoes the YAML.
  refreshIntervalMinutes: z.int().min(5).default(60),
  repoPath: z.string().min(1).default("/home/clawcode/homelab"),
});

/** Inferred Phase 999.47 homelab config type. */
export type HomelabConfig = z.infer<typeof homelabConfigSchema>;

/**
 * Heartbeat monitoring configuration schema.
 * Controls the periodic health check system for agents.
 */
export const heartbeatConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalSeconds: z.number().int().min(10).default(60),
  checkTimeoutSeconds: z.number().int().min(1).default(10),
  contextFill: z.object({
    warningThreshold: z.number().min(0).max(1).default(0.6),
    criticalThreshold: z.number().min(0).max(1).default(0.75),
    zoneThresholds: z.object({
      yellow: z.number().min(0).max(1).default(0.50),
      orange: z.number().min(0).max(1).default(0.70),
      red: z.number().min(0).max(1).default(0.85),
    }).default(() => ({ yellow: 0.50, orange: 0.70, red: 0.85 })),
  }).default(() => ({ warningThreshold: 0.6, criticalThreshold: 0.75, zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 } })),
});

/** Inferred heartbeat config type. */
export type HeartbeatConfig = z.infer<typeof heartbeatConfigSchema>;

/**
 * Schema for a single scheduled task entry.
 * Cron field accepts standard cron expressions or croner's extended format.
 * Validation of the cron expression itself happens at scheduler startup.
 */
export const scheduleEntrySchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(1),
  prompt: z.string().min(1),
  enabled: z.boolean().default(true),
});

/** Inferred schedule entry config type. */
export type ScheduleEntryConfig = z.infer<typeof scheduleEntrySchema>;

/**
 * Schema for a single slash command option.
 * Type field uses Discord's ApplicationCommandOptionType (1-11).
 */
export const slashCommandOptionSchema = z.object({
  name: z.string().min(1),
  type: z.number().int().min(1).max(11),
  description: z.string().min(1),
  required: z.boolean().default(false),
  // Phase 83 UI-01 — optional structured choices for STRING options (type 3).
  // When present, Discord renders a dropdown instead of a free-text input.
  // Capped at 25 entries per Discord API; each name/value must be 1..100 chars.
  // Optional + backward-compatible: pre-existing YAML configs parse unchanged.
  choices: z
    .array(
      z.object({
        name: z.string().min(1).max(100),
        value: z.string().min(1).max(100),
      }),
    )
    .max(25)
    .optional(),
});

/**
 * Schema for a single slash command entry.
 * Name must be lowercase alphanumeric with hyphens (Discord requirement).
 */
export const slashCommandEntrySchema = z.object({
  name: z.string().min(1).max(32).regex(/^[\w-]+$/),
  description: z.string().min(1).max(100),
  claudeCommand: z.string().min(1),
  options: z.array(slashCommandOptionSchema).default([]),
});

/** Inferred slash command option type. */
export type SlashCommandOptionConfig = z.infer<typeof slashCommandOptionSchema>;

/** Inferred slash command entry type. */
export type SlashCommandEntryConfig = z.infer<typeof slashCommandEntrySchema>;

/**
 * Webhook identity configuration schema.
 * Allows agents to post to Discord with custom display name and avatar.
 */
export const webhookConfigSchema = z.object({
  displayName: z.string().min(1),
  avatarUrl: z.string().url().optional(),
  webhookUrl: z.string().url().optional(),
});

/** Inferred webhook config type. */
export type WebhookConfig = z.infer<typeof webhookConfigSchema>;

/**
 * Thread management configuration schema.
 * Controls idle timeout and max concurrent thread sessions per agent.
 */
export const threadsConfigSchema = z.object({
  idleTimeoutMinutes: z.number().int().min(1).default(1440),
  // Phase 99 sub-scope N (2026-04-26) — lowered from 10 to 3 to cap
  // blast-radius if Layer 1 disallowedTools is somehow bypassed. Operator
  // can override per-agent in clawcode.yaml threads.maxThreadSessions.
  maxThreadSessions: z.number().int().min(1).default(3),
});

/** Inferred threads config type. */
export type ThreadsConfig = z.infer<typeof threadsConfigSchema>;

/**
 * Schema for a single allowlist entry (glob pattern for command matching).
 */
export const allowlistEntrySchema = z.object({
  pattern: z.string().min(1),
});

/**
 * Security configuration schema for per-agent execution approval.
 *
 * Phase 74 Plan 02 — `denyScopeAll` gates access to this agent from
 * scope='all' (multi-agent) bearer keys. Default `false` preserves
 * back-compat (any scope='all' key can target any configured agent).
 * Set `true` on admin-grade agents (e.g. admin-clawdy) so a compromised
 * OpenClaw-side scope='all' key cannot impersonate them via body.model.
 * The `openclaw:<slug>` template path is ALWAYS exempt from this flag —
 * that branch is a different code path entirely (no admin surface).
 */
export const securityConfigSchema = z.object({
  allowlist: z.array(allowlistEntrySchema).default([]),
  denyScopeAll: z.boolean().default(false),
});

/** Inferred security config type. */
export type SecurityConfig = z.infer<typeof securityConfigSchema>;

/**
 * Schema for an MCP server configuration entry.
 * Defines a server that Claude Code will connect to as an MCP client.
 */
/**
 * 999.103 WS-1 — live TodoWrite checklist mirrored to the agent's channel.
 * Disabled by default; canary agents opt in per-agent. `minItems` is the
 * multi-step floor: a TodoWrite list shorter than this never creates a card.
 */
export const todoMirrorSchema = z.object({
  enabled: z.boolean().default(false),
  minItems: z.number().int().min(1).max(20).default(2),
});

export const mcpServerSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  // Phase 85 TOOL-01 — when true, this server's readiness handshake
  // failure does NOT block the warm-path gate (agent still transitions
  // to `status: running`). Default false = mandatory (existing behavior
  // for every currently-configured MCP server; v2.1 migrated configs
  // parse unchanged). See src/mcp/readiness.ts.
  optional: z.boolean().default(false),
  /**
   * INC-2026-08-11 — minimum ms between heartbeat probes for this server while
   * it is steady-state healthy. 0 (the default) probes every tick, which is the
   * behavior every existing server has.
   *
   * A probe SPAWNS a throwaway copy of the server — connect handshake, then
   * capability probe — so a healthy server is started twice per 60s tick. That
   * is free for a stdio server and a full browser stack for
   * `playwright-shopping`. Opting in throttles the spawn while carrying the
   * prior readiness state forward unchanged.
   *
   * Only healthy servers are throttled: anything degraded/failed/unknown, and
   * anything with no prior state, is probed every tick regardless, so recovery
   * detection is unaffected. See src/mcp/probe-throttle.ts.
   */
  // `.optional()` not `.default(0)`: a defaulted field becomes REQUIRED in the
  // inferred output type, which breaks every mcpServer object literal in the
  // codebase. Absent is read as 0 by src/mcp/probe-throttle.ts.
  minProbeIntervalMs: z.number().int().min(0).optional(),
  // Phase 100 follow-up — operator-curated annotations surfaced in the
  // capability manifest. Helps the agent describe its tool surface
  // accurately ("the acme-db tool is read-only — I can SELECT
  // but not INSERT/UPDATE/DELETE"). Both fields optional so existing
  // YAML configs without these annotations parse unchanged.
  description: z.string().optional(),
  accessPattern: z.enum(["read-only", "read-write", "write-only"]).optional(),
  /**
   * Phase 999.54 (D-01, D-02) — when true, this server's tools are preloaded
   * into the turn-1 prompt instead of being deferred behind ToolSearch. Maps
   * 1:1 to the SDK's `McpStdioServerConfig.alwaysLoad` (sdk.d.ts:1067-1076).
   * Default omitted (NOT false) — preserves byte-stable schema-roundtrip for
   * the existing fleet. NON-RELOADABLE per Phase 999.54 D-04: changes require
   * `clawcode restart <agent>`. Note: per-agent overrides require the INLINE
   * form (`{name: clawcode, alwaysLoad: false}`), not the string-ref form
   * (`"clawcode"`), since strings carry no extra fields (RESEARCH.md Pitfall 6).
   */
  alwaysLoad: z.boolean().optional(),
});

/** Inferred MCP server config type from schema. */
export type McpServerSchemaConfig = z.infer<typeof mcpServerSchema>;

/**
 * Context budget configuration schema.
 * Controls per-source token budgets for the context assembly pipeline.
 * Values represent estimated token counts (chars/4 heuristic).
 */
export const contextBudgetsSchema = z.object({
  identity: z.number().int().positive().default(1000),
  hotMemories: z.number().int().positive().default(3000),
  toolDefinitions: z.number().int().positive().default(2000),
  graphContext: z.number().int().positive().default(2000),
});

/** Inferred context budgets type. */
export type ContextBudgetsConfig = z.infer<typeof contextBudgetsSchema>;

/**
 * Phase 53 — per-section assembly budgets in tokens.
 *
 * Section names are canonical (D-01 from 53-CONTEXT.md) and map 1:1 to
 * the assembler blocks that Wave 2 will emit token counts for. Budgets
 * are optional — unset means "use default" at the consumer. Positive
 * integers only; negative or zero values are rejected.
 */
export const memoryAssemblyBudgetsSchema = z.object({
  identity: z.number().int().positive().optional(),
  soul: z.number().int().positive().optional(),
  skills_header: z.number().int().positive().optional(),
  hot_tier: z.number().int().positive().optional(),
  recent_history: z.number().int().positive().optional(),
  per_turn_summary: z.number().int().positive().optional(),
  resume_summary: z.number().int().positive().optional(),
  /**
   * fleet-audit-2026-06-16 (H4) — per-agent override for the MEMORY.md
   * auto-load hard char cap (`INJECTED_MEMORY_MAX_CHARS`, default 16,000 —
   * `context-assembler.ts`). `tier1_budget_pct = injectChars / thisCap`, so a
   * heavy-monitor agent (Admin Clawdy, measured at 82% of budget) can lower this
   * to shrink its tier-1 injection cost WITHOUT a code change. Bounded
   * [1000, 16000]: the upper bound is the module-const ceiling (the stable
   * prefix's 8K-token outer cap leaves no room above it); the lower bound keeps
   * a usable head+tail slice. Omitted → the module const (16,000) — byte-for-byte
   * no-op for the fleet. Resolved at the MEMORY.md auto-load site in
   * `session-config.ts`; the per-section `identity` budget above still applies
   * downstream in the assembler.
   *
   * RELOADABLE per the `perf` block's reload semantics — but it only re-bites a
   * RUNNING primary on the next session-boundary prefix rebuild (the stable
   * prefix is frozen mid-session).
   */
  injectedMemoryMaxChars: z.number().int().min(1000).max(16000).optional(),
  /**
   * Phase 999.187 — per-agent cap for the USER.md auto-load that shares the
   * Tier 1 block with MEMORY.md (`INJECTED_USER_MAX_CHARS`, default 4,000).
   * Same head/tail truncation and `tier1-truncation` warn as MEMORY.md.
   */
  injectedUserMaxChars: z.number().int().min(500).max(16000).optional(),
});

/** Inferred Phase 53 memory-assembly budgets type. */
export type MemoryAssemblyBudgetsConfig = z.infer<
  typeof memoryAssemblyBudgetsSchema
>;

/**
 * Phase 53 — lazy-skill compression configuration.
 *
 * `usageThresholdTurns` has a hard floor of 5 (D-03 from 53-CONTEXT.md) —
 * anything smaller compresses skills too aggressively and defeats the
 * re-inflate cache-warming strategy.
 */
export const lazySkillsSchema = z.object({
  enabled: z.boolean().default(true),
  usageThresholdTurns: z.number().int().min(5).default(20),
  reinflateOnMention: z.boolean().default(true),
});

/** Inferred Phase 53 lazy-skills config type. */
export type LazySkillsConfig = z.infer<typeof lazySkillsSchema>;

/**
 * Phase 53 — session-resume summary hard token budget.
 *
 * Floor of 500 (D-04 from 53-CONTEXT.md) — below that the summary cannot
 * capture enough continuity for a useful session resume. Default 1500
 * applied at the consumer (src/memory/context-summary.ts in Wave 3),
 * NOT in the schema — keeps the Zod parse shape minimal.
 */
export const resumeSummaryBudgetSchema = z.number().int().min(500);

/**
 * Phase 54 — per-agent Discord streaming cadence.
 *
 * `editIntervalMs` has a HARD FLOOR of 300 ms (CONTEXT D-02 — absolute
 * Discord rate-limit safety net below which the 5-edits-per-5-seconds
 * bucket drains faster than it refills). Default 750 ms is applied at
 * the consumer (src/discord/streaming.ts ProgressiveMessageEditor in
 * Plan 54-03), NOT at the Zod layer — keeps the schema shape minimal.
 *
 * `maxLength` floors at 1 and ceilings at 2000 (Discord message
 * character limit). Default 2000 applied at consumer.
 */
export const streamingConfigSchema = z.object({
  editIntervalMs: z.number().int().min(300).optional(),
  maxLength: z.number().int().min(1).max(2000).optional(),
  /**
   * Phase 141 — v3 (claude-code-interactive) streaming activity level. Controls
   * how the mid-turn tool-activity indicator renders on the masking-webhook
   * stream, DECOUPLED from the `/clawcode-verbose` advisor flag.
   *   - `natural` (default) — a single humanized present-progressive phrase for
   *     the current tool (e.g. "🔍 Searching the web…"). No tool names/counts.
   *   - `raw` — the machinery line ("🔍 WebSearch ×2 · 🌐 WebFetch"); debugging.
   *   - `off` — prose only; no activity indicator.
   * Applied at the spawn (CLAWCODE_ACTIVITY_STYLE env → progress hook). Default
   * `natural` applied at the consumer. No-op for non-v3 / non-webhook agents.
   */
  activity: z.enum(["natural", "raw", "off"]).optional(),
});

/** Inferred Phase 54 streaming config type. */
export type StreamingConfig = z.infer<typeof streamingConfigSchema>;

/**
 * Phase 55 — default whitelist of idempotent ClawCode tools safe for
 * intra-turn caching. LOCKED verbatim per 55-CONTEXT D-02.
 *
 * These four tools are read-only from the agent's perspective: `memory_lookup`,
 * `search_documents`, `memory_list`, `memory_graph`. Repeated calls with
 * identical args within a single turn return identical results, so the intra-
 * turn cache can return the first result safely.
 *
 * Non-idempotent tools (memory_save, spawn_subagent_thread, ingest_document,
 * delete_document, send_message, send_to_agent, send_attachment, ask_advisor)
 * MUST NOT appear here — caching them is a correctness bug. Adding a tool to
 * this list requires a 55-CONTEXT amendment + explicit review.
 */
export const IDEMPOTENT_TOOL_DEFAULTS: readonly string[] = Object.freeze([
  "memory_lookup",
  "search_documents",
  "memory_list",
  "memory_graph",
  // Phase 71 (SEARCH-03) — web search MCP tools. Both are read-only from the
  // agent's perspective: `web_search` issues a GET to Brave/Exa and returns
  // a ranked list, `web_fetch_url` issues a GET for a URL and returns
  // extracted article text. Duplicate calls with identical args within a
  // single Turn are safe to serve from the intra-turn cache (no side
  // effects, deterministic response within the ~second-scale Turn window).
  "web_search",
  "web_fetch_url",
]);

/**
 * Phase 55 — per-tool SLO override for `perf.tools.slos.<tool_name>`.
 *
 * `thresholdMs` is required and must be a positive integer.
 * `metric` is optional — the consumer (`getPerToolSlo` in
 * src/performance/slos.ts) defaults it to `"p95"` when omitted so the common
 * case stays concise in clawcode.yaml.
 */
export const toolSloOverrideSchema = z.object({
  thresholdMs: z.number().int().positive(),
  metric: z.enum(["p50", "p95", "p99"]).optional(),
});

/** Inferred per-tool SLO override type. */
export type ToolSloOverride = z.infer<typeof toolSloOverrideSchema>;

/**
 * Phase 55 — `perf.tools` config. Three surfaces:
 *
 *   1. `maxConcurrent` — soft cap on concurrent tool-dispatch within a single
 *      turn. Default 10 per 55-CONTEXT D-01. Hard floor of 1 (a value of 0
 *      would deadlock the dispatcher).
 *
 *   2. `idempotent` — string[] whitelist of tools safe for intra-turn caching.
 *      Defaults to `IDEMPOTENT_TOOL_DEFAULTS`. Consumers get the full default
 *      whitelist automatically if they omit this field.
 *
 *   3. `slos` — optional `Record<tool_name, { thresholdMs, metric? }>` for
 *      per-tool SLO overrides. Consumed by `getPerToolSlo` which falls back to
 *      the global `tool_call` SLO (1500ms p95 — from DEFAULT_SLOS) when no
 *      override is set for a given tool.
 *
 * Parse output shape:
 *   { maxConcurrent: number; idempotent: string[]; slos?: Record<string, ToolSloOverride> }
 */
export const toolsConfigSchema = z.object({
  maxConcurrent: z.number().int().min(1).default(10),
  idempotent: z
    .array(z.string().min(1))
    .default([...IDEMPOTENT_TOOL_DEFAULTS]),
  slos: z.record(z.string().min(1), toolSloOverrideSchema).optional(),
});

/** Inferred Phase 55 perf.tools config type. */
export type ToolsConfig = z.infer<typeof toolsConfigSchema>;

/**
 * Phase 69 — OpenAI-compatible endpoint config (OPENAI-01..07).
 *
 * Lives under `defaults.openai` in clawcode.yaml. Controls the HTTP listener
 * that exposes `/v1/chat/completions` + `/v1/models` on the daemon process.
 *
 * DO NOT confuse with `mcpServers.openai` (unrelated MCP server entry). The
 * two keys live at different nesting levels and have no interaction.
 *
 * Every field has a default so omitting the entire block still yields a
 * fully-populated runtime config (enabled listener on 0.0.0.0:3101).
 *
 * Bounds rationale:
 *  - `port` 1..65535 — full TCP range; 0 forbidden to avoid OS-picked port.
 *  - `host` non-empty string; default `0.0.0.0` mirrors the dashboard.
 *  - `maxRequestBodyBytes` 1 KiB..100 MiB — sensible OpenAI message sizing.
 *  - `streamKeepaliveMs` 1s..2min — SSE keepalive comment cadence window.
 */
export const openaiEndpointSchema = z
  .object({
    enabled: z.boolean().default(true),
    port: z.number().int().min(1).max(65535).default(3101),
    host: z.string().min(1).default("0.0.0.0"),
    maxRequestBodyBytes: z
      .number()
      .int()
      .min(1024)
      .max(104857600)
      // CAM-01/02 — 10 MiB default (was 1 MiB). Up to ~3 downscaled base64
      // images per multimodal turn exceed 1 MiB; raised so vision requests
      // don't 413. Operators can still override per the schema range.
      .default(10485760),
    streamKeepaliveMs: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .default(15000),
  })
  // IMPORTANT: Must use factory-form default returning a fully-populated
  // literal (matching browserConfigSchema / searchConfigSchema / imageConfigSchema
  // pattern). A bare `.default({})` is a TRAP in Zod — when this schema appears
  // as a field in a parent z.object and the parent input omits the field, Zod
  // injects the literal default VALUE without re-running inner `.default()`
  // validators. Result: `{}` with no `enabled` key → `!config.enabled` trips
  // the disabled branch and the endpoint never binds. See
  // .planning/debug/resolved/clawdy-v2-stability.md (2026-04-19) for the full
  // forensic trail and the empirical reproduction.
  .default(() => ({
    enabled: true,
    port: 3101,
    host: "0.0.0.0",
    maxRequestBodyBytes: 10485760, // CAM-01/02 — 10 MiB (vision turns); see field default above
    streamKeepaliveMs: 15000,
  }));

/** Inferred Phase 69 OpenAI-endpoint config type. */
export type OpenAiEndpointConfig = z.infer<typeof openaiEndpointSchema>;

/**
 * Phase 70 — browser automation config (BROWSER-01..06).
 *
 * Governs the resident Chromium singleton warmed at daemon boot and the
 * per-agent BrowserContext persistence behavior. The auto-injected browser
 * MCP subprocess (clawcode browser-mcp — wired in Plan 02) delegates to the
 * daemon's BrowserManager; this schema shapes the manager's behavior, not
 * the subprocess transport.
 *
 * Architecture: `chromium.launch()` + per-agent
 * `browser.newContext({ storageState })` (70-RESEARCH.md Option 2 — Pitfall 1
 * forbids `launchPersistentContext` because it cannot share a Browser).
 *
 * DO NOT change `headless` to a string — Playwright 1.59 accepts the boolean
 * form and maps `true` to the new-headless mode. The `"new"` string the
 * CONTEXT.md draft mentioned is NOT a valid Playwright 1.59 launch option.
 *
 * Bounds rationale:
 *  - `navigationTimeoutMs` 1s..10min — 10 min hard ceiling prevents runaway
 *    agent behavior pinning a navigation forever.
 *  - `actionTimeoutMs` 100ms..5min — same ceiling philosophy at the
 *    action granularity (click/fill/wait_for).
 *  - `viewport` 320x240..7680x4320 — floor covers low-end phone emulation,
 *    ceiling matches 8K rendering (well above any realistic agent need).
 *  - `maxScreenshotInlineBytes` 0..5 MiB — 0 means "never inline" (always
 *    return path only); 5 MiB is Claude's per-image vision cap
 *    (70-RESEARCH.md Pitfall 7).
 */
export const browserConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    headless: z.boolean().default(true),
    warmOnBoot: z.boolean().default(true),
    navigationTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(600000)
      .default(30000),
    actionTimeoutMs: z
      .number()
      .int()
      .min(100)
      .max(300000)
      .default(10000),
    viewport: z
      .object({
        width: z.number().int().min(320).max(7680).default(1280),
        height: z.number().int().min(240).max(4320).default(720),
      })
      .default(() => ({ width: 1280, height: 720 })),
    userAgent: z.string().nullable().default(null),
    maxScreenshotInlineBytes: z
      .number()
      .int()
      .min(0)
      .max(5242880)
      .default(524288),
  })
  .default(() => ({
    enabled: true,
    headless: true,
    warmOnBoot: true,
    navigationTimeoutMs: 30000,
    actionTimeoutMs: 10000,
    viewport: { width: 1280, height: 720 },
    userAgent: null,
    maxScreenshotInlineBytes: 524288,
  }));

/** Inferred Phase 70 browser config type. */
export type BrowserConfig = z.infer<typeof browserConfigSchema>;

/**
 * Phase 71 — web search MCP config (SEARCH-01..03).
 *
 * Lives under `defaults.search` in clawcode.yaml. Governs the auto-injected
 * web-search MCP subprocess (Plan 02 wires the subprocess + CLI + daemon
 * auto-inject); this schema shapes the two pure tool handlers (`web_search`,
 * `web_fetch_url`) built in Plan 01.
 *
 * Architecture: backend union locked at `["brave", "exa"]` per 71-CONTEXT
 * D-01 (no Google CSE / DuckDuckGo / SerpAPI stubs). Provider API keys are
 * read LAZILY at client `search()` call time — missing keys at daemon boot
 * do NOT crash, they surface as structured `invalid_argument` errors on the
 * first call instead.
 *
 * Zero new npm deps: providers use native `fetch`, Readability extraction
 * reuses Phase 70's `@mozilla/readability` + `jsdom` import via
 * `src/search/readability.ts` (thin wrapper — no hoist).
 *
 * Bounds rationale:
 *  - `maxResults` 1..20 — hard cap 20 matches CONTEXT "maxResults: 20"
 *    (agents don't need more; providers charge per result).
 *  - `timeoutMs` 1s..60s — provider request budget; <1s is unreliable,
 *    >60s defeats intra-turn latency budgets.
 *  - `fetch.timeoutMs` 1s..2min — URL fetch has more variance than search
 *    (slow/redirecting sites); 2 min ceiling prevents runaway fetches.
 *  - `fetch.maxBytes` 1..10 MiB — 1 MiB default per CONTEXT, 10 MiB hard
 *    ceiling to keep agents from fetching absurd resource bundles.
 *  - `country` exactly 2 chars — ISO 3166 alpha-2 code validation.
 */
export const searchConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    backend: z.enum(["brave", "exa"]).default("brave"),
    brave: z
      .object({
        apiKeyEnv: z.string().min(1).default("BRAVE_API_KEY"),
        // Phase 110 follow-up — explicit op:// (or literal) override that
        // takes precedence over apiKeyEnv lookup. Lets operators store the
        // Brave key in 1Password instead of /etc/clawcode/env so Brave
        // joins the same secrets-resolver path used by FINNHUB / FAL /
        // STRAVA / etc. (clawcode.yaml zone 2). Resolved at daemon boot
        // via collectAllOpRefs → SecretsResolver.preResolveAll. If the
        // resolved value is non-empty it overrides whatever (if anything)
        // is in process.env[apiKeyEnv].
        apiKey: z.string().optional(),
        safeSearch: z.enum(["off", "moderate", "strict"]).default("moderate"),
        country: z.string().length(2).default("us"),
      })
      .default(() => ({
        apiKeyEnv: "BRAVE_API_KEY",
        safeSearch: "moderate" as const,
        country: "us",
      })),
    exa: z
      .object({
        apiKeyEnv: z.string().min(1).default("EXA_API_KEY"),
        // Same op:// passthrough as brave.apiKey above — keeps the two
        // backends symmetric for the same reason.
        apiKey: z.string().optional(),
        useAutoprompt: z.boolean().default(false),
      })
      .default(() => ({
        apiKeyEnv: "EXA_API_KEY",
        useAutoprompt: false,
      })),
    maxResults: z.number().int().min(1).max(20).default(20),
    timeoutMs: z.number().int().min(1000).max(60000).default(10000),
    fetch: z
      .object({
        timeoutMs: z.number().int().min(1000).max(120000).default(30000),
        maxBytes: z.number().int().min(1).max(10485760).default(1048576),
        userAgentSuffix: z.string().nullable().default(null),
      })
      .default(() => ({
        timeoutMs: 30000,
        maxBytes: 1048576,
        userAgentSuffix: null,
      })),
  })
  .default(() => ({
    enabled: true,
    backend: "brave" as const,
    brave: {
      apiKeyEnv: "BRAVE_API_KEY",
      safeSearch: "moderate" as const,
      country: "us",
    },
    exa: {
      apiKeyEnv: "EXA_API_KEY",
      useAutoprompt: false,
    },
    maxResults: 20,
    timeoutMs: 10000,
    fetch: {
      timeoutMs: 30000,
      maxBytes: 1048576,
      userAgentSuffix: null,
    },
  }));

/** Inferred Phase 71 search config type. */
export type SearchConfig = z.infer<typeof searchConfigSchema>;

/**
 * Phase 72 — image generation MCP config (IMAGE-01..04).
 *
 * Lives under `defaults.image` in clawcode.yaml. Governs the auto-injected
 * image-generation MCP subprocess (Plan 02 wires the subprocess + CLI +
 * daemon auto-inject); this schema shapes the three pure tool handlers
 * (`image_generate`, `image_edit`, `image_variations`) built in Plan 01.
 *
 * Architecture: backend union locked at `["openai", "minimax", "fal"]`
 * per 72-CONTEXT D-01 (no Stable Diffusion / Midjourney / video stubs).
 * Provider API keys are read LAZILY at client call time — missing keys at
 * daemon boot do NOT crash, they surface as structured `invalid_input`
 * errors on the first call instead.
 *
 * Zero new npm deps: providers use native `fetch` + native `FormData`
 * (Node 22 has both built-in).
 *
 * Bounds rationale:
 *  - `maxImageBytes` 1..10 MiB — 10 MiB ceiling matches the Discord
 *    attachment limit (Nitro-free guilds get 10 MiB) so generated
 *    artifacts can always be delivered via send_attachment.
 *  - `timeoutMs` 1s..5min — image generation has more variance than text
 *    (DALL-E HD can take 30-60s; flux-pro 10-20s); 5 min ceiling is the
 *    backend's own published max-runtime budget.
 *  - `workspaceSubdir` non-empty — defaults to `"generated-images"`;
 *    written to `<agent-workspace>/<workspaceSubdir>/<timestamp>-<id>.png`.
 */
export const imageConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    backend: z.enum(["openai", "minimax", "fal"]).default("openai"),
    openai: z
      .object({
        apiKeyEnv: z.string().min(1).default("OPENAI_API_KEY"),
        model: z.string().min(1).default("gpt-image-1"),
      })
      .default(() => ({
        apiKeyEnv: "OPENAI_API_KEY",
        model: "gpt-image-1",
      })),
    minimax: z
      .object({
        apiKeyEnv: z.string().min(1).default("MINIMAX_API_KEY"),
        model: z.string().min(1).default("image-01"),
      })
      .default(() => ({
        apiKeyEnv: "MINIMAX_API_KEY",
        model: "image-01",
      })),
    fal: z
      .object({
        apiKeyEnv: z.string().min(1).default("FAL_API_KEY"),
        model: z.string().min(1).default("fal-ai/flux-pro"),
      })
      .default(() => ({
        apiKeyEnv: "FAL_API_KEY",
        model: "fal-ai/flux-pro",
      })),
    maxImageBytes: z.number().int().min(1).max(10485760).default(10485760),
    timeoutMs: z.number().int().min(1000).max(300000).default(60000),
    workspaceSubdir: z.string().min(1).default("generated-images"),
  })
  .default(() => ({
    enabled: true,
    backend: "openai" as const,
    openai: { apiKeyEnv: "OPENAI_API_KEY", model: "gpt-image-1" },
    minimax: { apiKeyEnv: "MINIMAX_API_KEY", model: "image-01" },
    fal: { apiKeyEnv: "FAL_API_KEY", model: "fal-ai/flux-pro" },
    maxImageBytes: 10485760,
    timeoutMs: 60000,
    workspaceSubdir: "generated-images",
  }));

/** Inferred Phase 72 image config type. */
export type ImageConfig = z.infer<typeof imageConfigSchema>;

// ---------------------------------------------------------------------------
// Phase 117 Plan 06 — advisor helper schemas (defaults + per-agent override).
//
// The advisor block configures which `AdvisorBackend` answers `ask_advisor`
// tool calls and `/advise` IPC requests for each agent. The Phase 117 spec
// (CONTEXT.md `<decisions>.Architecture`, LOCKED) treats the swap from the
// legacy fork backend to the native SDK `advisorModel` option as a feature-
// flag rollout — the default is `"native"` and operators can flip any one
// agent back to `"fork"` via `clawcode reload` without a redeploy. Same
// pattern as Phase 110 Stage 0b's `defaults.shimRuntime` canary dial.
//
// Backend enum is `"native" | "fork"` only. The `"portable-fork"` value
// surfaced in `BackendId` (`src/advisor/types.ts:30`) is intentionally
// EXCLUDED from this schema — Plan 117-05 ships the scaffold but Phase 118
// owns the rollout. Operators who put `portable-fork` in YAML must see a
// hard schema rejection (regression-pinned in
// `__tests__/schema-advisor.test.ts` assertion C).
//
// Model string is stored verbatim (e.g. `"opus"`, `"sonnet"`, or a fully-
// qualified SDK id `"claude-opus-4-8"`). The SDK call site resolves the
// alias via `resolveAdvisorModel` shipped in Plan 117-02
// (`src/manager/model-resolver.ts`) — that resolver canonicalises `"opus"`
// → `"claude-opus-4-8"`. Do NOT canonicalise here; the schema's only job
// is shape validation.
//
// Caching defaults (`enabled: true`, `ttl: "5m"`) are Anthropic's
// recommended setting for ≥3 advisor invocations per conversation (see
// CONTEXT.md). The `maxUsesPerRequest` default of 3 matches the Anthropic
// example budget cited in the plan; range 1–10 keeps the operator from
// burning budget on a misconfigured agent.
// ---------------------------------------------------------------------------
export const advisorBackendSchema = z.enum(["native", "fork"]); // "portable-fork" intentionally excluded — Phase 118 follow-up

// ---------------------------------------------------------------------------
// Phase 136 — LlmRuntime (primary agent runtime) backend schema.
//
// The Zod source of truth for what operators can put in `clawcode.yaml`
// under `agents[*].llmRuntime.backend` / `defaults.llmRuntime.backend`.
// Phase 136 ships ONE accepted value — `"anthropic-agent-sdk"`, the
// current production runtime extracted into `AnthropicAgentSdkBackend`.
//
// Phase 137 widens this enum to add `"anthropic-api-key"` (pay-as-you-go
// safety valve when the 2026-06-15 Agent SDK credit cap depletes).
// Phase 140 adds `"claude-code-interactive"` (probe-gated, drives the real
// claude CLI binary under a node-pty supervisor). Phase 141 adds
// `"openai-codex"`,
// Phase 142 adds `"openrouter"`. The `"portable-fork"` literal is
// intentionally EXCLUDED — it exists as a scaffold-only backend (mirrors
// Phase 117 `portable-fork` advisor) and is unselectable from YAML.
//
// See:
//   - .planning/phases/136-llm-runtime-multi-backend/136-CONTEXT.md §D-04
//   - src/llm-runtime/types.ts — LlmRuntimeBackend type union (mirror of
//     this enum; the two must stay in sync).
// ---------------------------------------------------------------------------
// Phase 137 Plan 01 — enum widened to add "codex-cli".
// CONTEXT.md D1 / 137-01-PLAN T-02. The CodexAgentCli backend is a
// SHELL in Plan 01 (loadSdkModule throws a Plan-03 deferral error);
// the enum is widened NOW so daemon construction works when an
// operator flips the flag, and Plans 02–05 fill in the wire shape
// behind the same enum value.
export const llmRuntimeBackendSchema = z.enum([
  "anthropic-agent-sdk",
  "codex-cli",
  // Phase 140 — v3 native-channels backend. Selectable but inert in Plan 01
  // (FakeChannelsSdkModule); the PTY supervisor + live channel socket land in
  // Stage 2. Widening this single enum also widens `failoverChain` (below) and
  // the per-agent failover override fields, so an operator can `clawcode
  // failover set <agent> claude-code-interactive` once Stage 2 is wired.
  "claude-code-interactive",
]);

// Phase 137 Plan 01 — Codex-specific sub-config block. Optional;
// when unset, discovery falls back to PATH lookup + the
// CODEX_DEFAULT_COMMON_PATHS list at
// `src/llm-runtime/backends/codex-agent-cli.ts`. Mirrors the
// existing Anthropic Agent SDK `pathToClaudeCodeExecutable` field
// shape (string, optional). NON_RELOADABLE — captured into spawn-env
// at agent boot; flipping requires `clawcode restart` (see
// `src/config/types.ts` NON_RELOADABLE_FIELDS).
export const llmRuntimeCodexConfigSchema = z.object({
  pathToCodexExecutable: z.string().optional(),
  // Phase 137 Plan 03 T-03 — operator-overridable Codex model id.
  // Default "gpt-5-codex" per CONTEXT D1. The default is captured
  // into the spawn-arg list at agent boot (CodexSdkModule reads
  // config.llmRuntime.codex.model once at query construction); a
  // YAML edit takes effect on the next `clawcode restart` — listed
  // in NON_RELOADABLE_FIELDS at src/config/types.ts:351-354 below.
  //
  // researcher_todo #7: confirm "gpt-5-codex" is the current model
  // id at deploy time. If renamed/deprecated, this default is the
  // single source of truth; per-agent overrides remain via the
  // existing cascade (agents[].llmRuntime.codex.model).
  model: z.string().default("gpt-5-codex"),
});

export const llmRuntimeConfigSchema = z.object({
  backend: llmRuntimeBackendSchema.default("anthropic-agent-sdk"),
  codex: llmRuntimeCodexConfigSchema.optional(),
  // Phase 138 Plan 05 D4 — ordered list of fallback backend IDs,
  // evaluated left-to-right at failover trigger time (a provider
  // crossing 95% of its daily cap flips every agent on that provider
  // WITH a non-empty chain to `failoverChain[0]`). Default empty: no
  // failover, warn-only on a 95% crossing.
  //
  // CRITICAL: `z.array(llmRuntimeBackendSchema)` — NOT
  // `z.array(z.string())`. `llmRuntimeBackendSchema` is the Phase 137
  // enum (`anthropic-agent-sdk` | `codex-cli`); `"portable-fork"` is a
  // scaffold-only backend (Phase 137 D5) and is REJECTED at parse time.
  // A plain `z.array(z.string())` would accept bogus IDs that then
  // throw deep in the factory switch at construction.
  //
  // RELOADABLE (planner extension to CONTEXT D4 — D4 locks the schema +
  // cascade, the RELOADABLE classification is planner judgment):
  // operators opt in / out of failover without a daemon restart. See
  // `src/config/types.ts` RELOADABLE_FIELDS.
  failoverChain: z.array(llmRuntimeBackendSchema).default([]),
  // Phase 999.84 Plan 04 (Model A pivot) — opt-in to claude's official
  // `plugin:discord@claude-plugins-official` turn-source for v3 chat
  // agents. When true, the spawned `claude --channels` argv carries BOTH
  // `server:clawcode-channel` AND `plugin:discord@...` (Model A "2-bot");
  // the agent reads its own DISCORD_BOT_TOKEN from
  // `~/.clawcode/channels-state/<agent>/.env`. When false (default), only
  // the experimental clawcode-channel is loaded (Model B "1 daemon bot"
  // — the path 999.84 investigation falsified as flaky). Applies only to
  // the `claude-code-interactive` backend; no-op for SDK backends.
  // RELOADABLE: false (must respawn the `claude --channels` child to
  // change the argv shape).
  includeDiscordPlugin: z.boolean().optional(),
  // Phase 141 (#4) — v3 PTY permission mode → `--permission-mode <mode>` on the
  // `claude --channels` spawn. A headless daemon-spawned PTY has no TTY to answer
  // a permission prompt, so the v3 spawn defaults to `bypassPermissions` (parity
  // with the v2 SDK path, which hardcodes it at session-adapter.ts:1312/1469).
  // Operators override per-agent for a stricter mode (e.g. `plan`). Applies only
  // to `claude-code-interactive`; no-op for SDK backends. NON_RELOADABLE — the
  // argv is locked at spawn (absent from RELOADABLE_FIELDS, like includeDiscordPlugin).
  permissionMode: z
    .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
    .optional(),
  // Phase 999.86 — pre-warmed worker pool sizing for v3 chat.
  // `size` = idle workers parked on the menu prompt (default 1).
  // `maxConcurrent` = simultaneous workers cap (default size+2).
  // Active only when CLAWCODE_WARM_POOL=1 on the daemon.
  warmPool: z
    .object({
      size: z.number().int().min(0).optional(),
      maxConcurrent: z.number().int().min(1).optional(),
    })
    .optional(),
});

// ---------------------------------------------------------------------------
// Phase 137 Plan 04 — per-provider credentials surface.
// ---------------------------------------------------------------------------
//
// `providers.openai.apiKeyPath` accepts either:
//   - an `op://example-vault/item/field` URI resolved at agent first turn via
//     the existing Phase 999.10 SecretsResolver, OR
//   - a plaintext `sk-...` value (operator escape hatch — `op://` is
//     the recommended production form).
//
// The path resolves through `OpenAiCredentialsResolver` (at
// `src/llm-runtime/credentials/openai-credentials.ts`) which delegates
// `op://`-prefixed values to SecretsResolver.resolve() and returns
// plaintext values verbatim. The resolved key is injected into the
// spawned Codex child's env as `OPENAI_API_KEY` — Anthropic OAuth
// bearer tokens and OpenAI keys NEVER share an env surface
// (auth-surface separation invariant, see CONTEXT known_constraints).
//
// RELOADABLE — credentials rotation is hot-swap: ConfigWatcher delta
// invalidates the per-agent resolver cache so the next turn picks up
// the new key without daemon restart. See types.ts RELOADABLE_FIELDS
// entries for `providers.openai.apiKeyPath`.
//
// Cascade per agent: agents[].providers.openai.apiKeyPath ??
//   defaults.providers.openai.apiKeyPath ?? undefined. Same shape as
// Phase 117 advisor cascade.
//
// SC4 satisfied: "Per-provider credentials surface: clawcode.yaml
// accepts providers.openai.apiKeyPath (1Password reference)."
//
// See:
//   - .planning/phases/137-.../137-04-PLAN.md T-01
//   - src/llm-runtime/credentials/openai-credentials.ts (T-02)
//   - src/manager/daemon.ts daemon wiring (T-03)
export const openAiProviderSchema = z.object({
  /**
   * 1Password `op://example-vault/item/field` URI OR a plaintext `sk-...`
   * value. Empty string rejected at parse time. Resolution is lazy
   * (first turn, not boot) — absent or invalid values surface as a
   * `OpenAiCredentialsMissingError` on the agent's first Codex turn.
   */
  apiKeyPath: z.string().min(1).optional(),
  // Phase 138 D6 — per-provider daily cost cap in USD. The default is
  // applied at the CONSUMER (see DEFAULT_DAILY_CAP_USD in
  // src/usage/provider-usage-tracker.ts), NOT as a Zod default — a
  // missing field must stay distinguishable from an explicit 6.67.
  // RELOADABLE — cap tuning is hot-swap; see RELOADABLE_FIELDS in
  // src/config/types.ts.
  dailyCapUsd: z.number().positive().optional(),
});

// Phase 138 D6 — Anthropic side of the per-provider cost surface.
// Sibling of `openAiProviderSchema` but with NO apiKeyPath field:
// Anthropic auth uses OAuth bearer tokens sourced from the existing
// claude-cli login flow, not clawcode.yaml. The only field is the
// daily cost cap.
export const anthropicProviderSchema = z.object({
  // Phase 138 D6 — per-provider daily cost cap in USD. Same consumer-
  // applied-default semantics as openAiProviderSchema.dailyCapUsd.
  dailyCapUsd: z.number().positive().optional(),
});

export const providersConfigSchema = z.object({
  openai: openAiProviderSchema.optional(),
  // Phase 138 D6 — Anthropic per-provider block (cost cap only).
  anthropic: anthropicProviderSchema.optional(),
});

// ---------------------------------------------------------------------------
// Bridge (spawned `claude` one-shot helper) config
// ---------------------------------------------------------------------------
//
//   - haikuDirectRouting : "bridge" routes haiku-direct calls through the
//     bundled `claude` binary; "direct" uses the Anthropic SDK directly.
//
// RELOADABLE (`defaults.bridge` prefix in RELOADABLE_FIELDS).
// ---------------------------------------------------------------------------
export const bridgeHaikuDirectRoutingSchema = z.enum(["bridge", "direct"]);

export const bridgeConfigSchema = z.object({
  haikuDirectRouting: bridgeHaikuDirectRoutingSchema.default("bridge"),
});

/**
 * Per-agent llmRuntime override — every field optional so an operator can
 * flip just `backend` without re-specifying anything else. Loader resolver
 * (`resolveLlmRuntimeBackend` below) handles the per-agent → defaults →
 * hardcoded-baseline fall-through. Mirrors `agentAdvisorOverrideSchema`
 * (Phase 117).
 */
export const agentLlmRuntimeOverrideSchema = z
  .object({
    backend: llmRuntimeBackendSchema.optional(),
    // Phase 137 Plan 01 — per-agent codex override. Every field
    // inside optional so an operator can set just
    // `pathToCodexExecutable` without re-specifying anything else.
    codex: llmRuntimeCodexConfigSchema.optional(),
    // Phase 138 Plan 05 D4 — per-agent failover-chain override. Same
    // strict `z.array(llmRuntimeBackendSchema)` typing as the defaults
    // block above (`portable-fork` rejected at parse time). Optional —
    // an agent without this field inherits `defaults.llmRuntime.
    // failoverChain` via the loader cascade.
    failoverChain: z.array(llmRuntimeBackendSchema).optional(),
    // Phase 999.84 Plan 04 — per-agent Model A opt-in (see
    // llmRuntimeConfigSchema for the architectural rationale). Per-agent
    // override; an unset value falls through to the defaults block.
    includeDiscordPlugin: z.boolean().optional(),
    // Phase 141 (#4) — per-agent v3 permission-mode override (see
    // llmRuntimeConfigSchema for rationale). Unset → defaults cascade →
    // buildChannelsArgv's `bypassPermissions` fallback.
    permissionMode: z
      .enum(["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"])
      .optional(),
    // Phase 999.86 — per-agent warm worker pool sizing. Unset values
    // fall through to defaults via the loader cascade.
    warmPool: z
      .object({
        size: z.number().int().min(0).optional(),
        maxConcurrent: z.number().int().min(1).optional(),
      })
      .optional(),
  })
  .partial();
export const advisorCachingSchema = z.object({
  enabled: z.boolean().default(true),
  ttl: z.enum(["5m", "1h"]).default("5m"),
});
export const advisorConfigSchema = z.object({
  backend: advisorBackendSchema.default("native"),
  model: z.string().default("opus"),
  maxUsesPerRequest: z.number().int().min(1).max(10).default(3),
  // 2026-08-27 — fork-backend consult bound. The parent turn BLOCKS on the
  // fork; the hard-coded 600 s let a fork that fanned out subagents hold a
  // chat turn for 6+ minutes (fin-client, 19:09 PT). On expiry the fork
  // is aborted + stopped and the agent proceeds with an "advisor unavailable
  // (advisor_timeout)" footer. Native backend ignores this.
  forkTimeoutMs: z.number().int().min(30_000).max(600_000).default(180_000),
  caching: advisorCachingSchema.optional(),
});

// ---------------------------------------------------------------------------
// Phase 999.117 WS-3 — agent-to-agent loop governance.
// ---------------------------------------------------------------------------
//
// ClawCode previously had NO bound on an A2A conversation: no hop count, no
// TTL, no conversation identity, no per-pair budget. The only guard was
// "never ack an ack", which does nothing for a genuine A→B→A→B exchange —
// two agents each behaving correctly could ping-pong indefinitely.
//
// Four independent bounds, deliberately redundant because each fails
// differently (see src/collaboration/loop-governor.ts for the full
// rationale and the prior art each one comes from).
//
// `mode` is the rollback dial, mirroring the Phase 110 shimRuntime and
// Phase 117 advisor.backend canaries:
//   "enforce" (default) — suppress traffic that breaches a bound
//   "shadow"            — compute + report verdicts, deliver anyway. Use to
//                         retune a threshold against real load without
//                         turning protection off entirely.
//   "off"               — no evaluation
//
// NOT hot-reloadable: the governor holds in-memory counters built at daemon
// boot. A mode or threshold change needs a restart. Do not assume otherwise
// — several knobs in this file were documented reloadable and were not
// (`allowedModels`, `verification.ux`, `heartbeat.enabled`).
export const a2aGovernorConfigSchema = z.object({
  mode: z.enum(["enforce", "shadow", "off"]).default("enforce"),
  /** Max hops in one conversation (TTL / max hop count). */
  maxHops: z.number().int().min(1).max(100).default(6),
  /** Max back-to-back messages on one ordered pair with no third party. */
  maxConsecutiveAutoReplies: z.number().int().min(1).max(50).default(3),
  /** Rate-limit window length, ms. */
  pairWindowMs: z.number().int().min(1_000).max(3_600_000).default(300_000),
  /** Max messages per ordered pair per window. */
  pairWindowMax: z.number().int().min(1).max(200).default(5),
  /**
   * Unconditional per-conversation ceiling. The last kill switch — it does
   * not reason about structure, it just counts, so an agent cannot escape it
   * by minting a fresh conversation id or alternating targets. Never disable.
   */
  conversationCap: z.number().int().min(1).max(500).default(12),
  /** How long a tripped pair stays suppressed, ms. */
  breakerCooldownMs: z.number().int().min(1_000).max(86_400_000).default(900_000),
  /**
   * Silence after which a pair's next message starts a NEW conversation.
   *
   * This is what makes the depth bounds usable at all. The tool schemas carry
   * no conversation id and the recipient never sees one to thread back, so
   * the governor derives the conversation from the pair plus this window.
   * Two agents that talk, go quiet, then talk again about something else are
   * having two conversations — not one that slowly exhausts conversationCap.
   */
  conversationIdleMs: z.number().int().min(1_000).max(86_400_000).default(600_000),
});

export type A2aGovernorConfig = z.infer<typeof a2aGovernorConfigSchema>;

/** Phase 999.117 — fleet-wide agent-to-agent block. */
export const a2aConfigSchema = z.object({
  // `.optional()` rather than `.default({})` — matches the advisor/caching
  // idiom in this file, and Zod 4 requires a COMPLETE object literal for
  // `.default`. An omitted block resolves to DEFAULT_LOOP_GOVERNOR_CONFIG in
  // the daemon; a present-but-partial block gets this schema's per-field
  // defaults.
  governor: a2aGovernorConfigSchema.optional(),
  /**
   * Phase 999.144 — cryptographic envelope auth for the webhook relay
   * (INCIDENT-webhook-spam-2026-09-16: dispatch was gated on footer FORMAT
   * alone; anyone holding a leaked bound-channel webhook URL plus the public
   * footer format could have content dispatched as an agent turn).
   *
   *   off     — pre-999.144 behavior, no evaluation.
   *   shadow  — verify + log verdicts, always deliver. Rollout default:
   *             watch `a2a-envelope-auth` log lines for unexpected
   *             unsigned/bad-signature before enforcing.
   *   enforce — only embeds carrying a valid daemon HMAC dispatch a turn.
   *             Also (by design) retires the ask-agent mirror double-run:
   *             mirror embeds are unsigned display-only.
   *
   * Boot-applied like the governor (the bridge captures it at wiring time).
   */
  envelopeAuth: z.enum(["off", "shadow", "enforce"]).optional(),
});

export type A2aConfig = z.infer<typeof a2aConfigSchema>;

// ---------------------------------------------------------------------------
// Phase 999.100 — mid-turn intent steering knobs (defaults + per-agent).
// ---------------------------------------------------------------------------
//
// Governs the v2 main-channel bridge gate that classifies messages arriving
// while the agent's turn is in flight (steer / new_task / stop) and, on
// "steer", injects the message into the RUNNING turn's SDK input stream.
// `autoClassify` is the master switch and defaults OFF fleet-wide — with it
// off the bridge short-circuits before any new code runs (byte-identical
// pre-feature behavior). RELOADABLE: the bridge reads the resolved block
// per message via getAgentConfig, so YAML flips apply on config save.
export const steeringConfigSchema = z.object({
  /** Master switch for mid-turn intent classification on main channels. */
  autoClassify: z.boolean().default(false),
  /**
   * Allow the "stop" intent to abort the running turn. Disabling turns off
   * BOTH the whole-message stop-verb heuristic and the LLM stop route.
   */
  stopIntent: z.boolean().default(true),
  /** Per-turn cap on steer injections (guards runaway rapid-fire steers). */
  maxInjectionsPerTurn: z.number().int().min(1).max(10).default(3),
  /** LLM steer classifications below this confidence queue instead. */
  minConfidence: z.number().min(0).max(1).default(0.75),
  /** LLM stop classifications below this confidence queue instead (stop is
   *  destructive, so its bar sits above the steer bar). */
  stopMinConfidence: z.number().min(0).max(1).default(0.85),
  /**
   * Haiku classifier deadline; timeout → new_task (fail-safe).
   * 2026-08-02: default 4000 → 12000 — a COLD haiku-direct spawn measured
   * 5.2s end-to-end on prod, so the 4s default SIGTERM'd the first-ever
   * live classification (exit 143 @ 4.5s) and every steer fell back to
   * new_task. 12s = ~2.3× the measured cold path.
   */
  classifierTimeoutMs: z.number().int().min(500).max(30_000).default(12_000),
});

/** Per-agent steering override — every field optional so operators can flip
 * just `autoClassify` (canary pattern) without re-specifying the rest. Raw
 * optionals (no inner .default()s) keep operator-explicit vs operator-omitted
 * distinguishable at the per-agent boundary — same rationale as
 * `agentAdvisorOverrideSchema`'s caching shape above. */
export const agentSteeringOverrideSchema = z
  .object({
    autoClassify: z.boolean().optional(),
    stopIntent: z.boolean().optional(),
    maxInjectionsPerTurn: z.number().int().min(1).max(10).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
    stopMinConfidence: z.number().min(0).max(1).optional(),
    classifierTimeoutMs: z.number().int().min(500).max(30_000).optional(),
  })
  .partial();

/** Per-agent advisor override — every field optional so operators can flip
 * just `backend` (or just `model`, etc.) without re-specifying the rest.
 * Loader resolvers (`resolveAdvisorBackend` etc. in `./loader.ts`) handle
 * the per-agent → defaults → hardcoded-baseline fall-through.
 *
 * Caching uses a raw inner schema (no .default()s) so an unset sub-field
 * stays `undefined` after parse. `advisorCachingSchema.partial()` would
 * still apply the `enabled: true` / `ttl: "5m"` defaults at parse time,
 * which would short-circuit `resolveAdvisorCaching`'s per-field fall-
 * through to `defaults.advisor.caching`. The schema for the per-agent
 * override therefore intentionally diverges from the defaults-side
 * caching schema — `advisorCachingSchema` keeps defaults for the
 * defaults block; the inline shape below preserves operator-explicit
 * vs. operator-omitted at the per-agent boundary. */
export const agentAdvisorOverrideSchema = z
  .object({
    backend: advisorBackendSchema.optional(),
    model: z.string().optional(),
    maxUsesPerRequest: z.number().int().min(1).max(10).optional(),
    forkTimeoutMs: z.number().int().min(30_000).max(600_000).optional(),
    caching: z
      .object({
        enabled: z.boolean().optional(),
        ttl: z.enum(["5m", "1h"]).optional(),
      })
      .optional(),
  })
  .partial();

/**
 * Phase 999.63 Plan 04 — financial-verification per-agent enforcement
 * override (CONTEXT.md D6).
 *
 * The Phase 999.63 enforcement gate (Plan 03) re-prompts an agent when a
 * turn emits financial figures without calling a verification tool. D6
 * scopes the gate to agents whose name prefix-matches `fin-` / `acme-`
 * by default. This optional block lets an operator override that default in
 * BOTH directions per agent:
 *   - `enforced: true`  → opts a non-fin agent IN.
 *   - `enforced: false` → opts a fin agent OUT.
 *
 * `enforced` is `.optional()` so an omitted field stays `undefined` after
 * parse — the resolver (`isVerificationEnforced`) then falls back
 * to the prefix-rule default. Existing `clawcode.yaml` files load unchanged
 * (backwards-compatible additive schema).
 *
 * Used on BOTH the per-agent (`agentSchema.verification`) and the
 * `defaults.verification` surfaces — same per-agent cascade shape
 * as Phase 117 `advisor` / Phase 137 `llmRuntime`.
 *
 * RELOADABLE — enforcement is evaluated per-turn at dispatch time (the
 * `verificationOverride` DI closure reads the live resolved config
 * on every gate call), NOT captured at agent spawn. A config edit +
 * `clawcode reload` takes effect on the next turn. Deliberately NOT added
 * to `NON_RELOADABLE_FIELDS`.
 */
/**
 * 999.63b — rule-claim class per-agent override surface. Both knobs are
 * RAW `.optional()` (no inner defaults) so operator-explicit stays
 * distinguishable from operator-omitted and the loader's per-knob cascade
 * (agent ?? defaults ?? built-in) works — same rationale as the parent
 * block's budget knobs.
 *
 *   - enabled: false disables rule-claim classification entirely for the
 *     agent (legacy figures-only behavior).
 *   - maxVerifyHops: 0 = shadow (telemetry-only, the fleet default), 1 =
 *     enforce one corrective hop for rule claims, 2 = max.
 */
export const financialRuleClaimsOverrideSchema = z.object({
  enabled: z.boolean().optional(),
  maxVerifyHops: z.number().int().min(0).max(2).optional(),
});

export const verificationConfigSchema = z.object({
  enforced: z.boolean().optional(),
  /**
   * 2026-07-31 adaptive verify budget — per-agent override surface. All
   * four knobs are RAW `.optional()` (no inner defaults) so operator-
   * explicit stays distinguishable from operator-omitted and the loader's
   * per-knob cascade (agent ?? defaults ?? built-in) works — same
   * rationale as `agentSteeringOverrideSchema`.
   *
   *   - maxVerifyHops: 0 = telemetry-only (no corrective hop ever), 1 =
   *     the D4 single-hop default, 2 = max.
   *   - skipIfTurnMsOver: skip the corrective hop entirely when the
   *     parent turn's wall-time reached this.
   *   - shrinkIfTurnMsOver: run the hop at `low` effort when the parent
   *     turn's wall-time reached this.
   *   - deferMs: idle-defer before dispatching the hop; the hop is
   *     skipped when user traffic arrived during the window.
   */
  maxVerifyHops: z.number().int().min(0).max(2).optional(),
  skipIfTurnMsOver: z.number().int().min(5_000).optional(),
  shrinkIfTurnMsOver: z.number().int().min(1_000).optional(),
  deferMs: z.number().int().min(0).max(30_000).optional(),
  /** 999.63b — rule-claim class knobs (see financialRuleClaimsOverrideSchema). */
  ruleClaims: financialRuleClaimsOverrideSchema.optional(),
  /**
   * C (2026-08-26) — pre-delivery hold mode. RAW `.optional()` like the
   * budget knobs (operator-explicit vs omitted must stay distinguishable
   * for the loader cascade). `holdDelivery: true` verifies BEFORE the
   * response lands on Discord (placeholder streaming + bounded hold);
   * `holdTimeoutMs` caps the hold (fail-open to deliver-then-correct).
   */
  holdDelivery: z.boolean().optional(),
  holdTimeoutMs: z.number().int().min(5_000).max(120_000).optional(),
  /**
   * 999.63d "verified streaming" — cosmetic UX sub-block (nested like
   * `ruleClaims`, not flat: three related toggles, room for future knobs).
   * RAW `.optional()` — operator-explicit vs omitted must stay
   * distinguishable for the loader's per-knob cascade.
   *   - streamStatus:  live status line in the message slot during
   *     pre-text tool phases (draft streaming untouched).
   *   - streamStatusMode: WHEN that trail arms (999.63d/5). `streamStatus`
   *     is the on/off switch; this is the position it sits in.
   *       "always" — every turn with a pre-text tool phase.
   *       "topic"  — only when the inbound prompt reads as a financial
   *                  topic. Strictest reading of "only when necessary for
   *                  verification", but a turn whose financial substance
   *                  is in the WORK rather than the ask paints nothing
   *                  (the 2026-08-26 12-plan audit).
   *       "auto"   — DEFAULT. Topic prompts paint from the first event;
   *                  any other turn paints only once it proves it is
   *                  working (3 tool events, or 20s with no draft text).
   *   - pendingMarker: "-# Verifying…" appended to a flagged delivered
   *     message while the corrective hop runs.
   *   - verifiedBadge: ✅ reaction on inline-verified turns.
   */
  /**
   * 999.63d/6 — per-agent TOPIC. Selects which vocabulary decides that a
   * turn is worth narrating. `profile` names a built-in bundle;
   * `extraTerms` widens it (ADD-ONLY — the built-in lists are frozen and
   * static-grep pinned, so config can raise the floor but never lower
   * it). An all-uppercase extra term joins the case-sensitive acronym
   * set, matching how the built-ins treat `IRA` vs the name "Ira".
   *
   * Display scope only: this decides whether the activity trail paints.
   * It is NOT the vocabulary behind the verification gate itself.
   */
  topic: z
    .object({
      profile: z.enum(["finance", "legal", "none"]).optional(),
      extraTerms: z.array(z.string().min(1).max(64)).max(40).optional(),
    })
    .optional(),
  ux: z
    .object({
      streamStatus: z.boolean().optional(),
      streamStatusMode: z.enum(["always", "topic", "auto"]).optional(),
      /**
       * 2026-08-27 — treat short pre-answer text fragments ("Reading the
       * source first.") as activity-trail lines instead of draft text.
       * Measured on fin-client: the model narrates between tool calls,
       * the first fragment set `draftStarted`, and the trail stood down on
       * exactly the long turns it exists for. Default OFF.
       */
      narrationAsTrail: z.boolean().optional(),
      /** 2026-08-27 verification v2 — delivery UX (Sources line, verdict reactions, ledger card). */
      sourcesFooter: z.enum(["off", "claims", "always"]).optional(),
      verdictReactions: z.boolean().optional(),
      modelSourcesLine: z.enum(["keep", "strip", "flag"]).optional(),
      ledgerButton: z.boolean().optional(),
      ledgerReaction: z.string().max(8).optional(),
      liveClaims: z.boolean().optional(),
      // 2026-08-27 — "separate": the verification trail gets its OWN message
      // (posted immediately, updated in place, settled at delivery) and the
      // answer arrives in its own message(s). "inline" (default) keeps the
      // legacy shared-slot behaviour.
      statusMessage: z.enum(["inline", "separate"]).optional(),
      unverifiedNotice: z.boolean().optional(),
      compactBelowChars: z.number().int().min(0).max(2000).optional(),
      sourcesCharBudget: z.number().int().min(80).max(1500).optional(),
      pendingMarker: z.boolean().optional(),
      verifiedBadge: z.boolean().optional(),
    })
    .optional(),
});

/**
 * 2026-07-31 — fleet-defaults surface for the same block. Numeric knobs
 * carry `.default()`s single-sourced from
 * `VERIFICATION_BUDGET_DEFAULTS` (the exact values the runner
 * falls back to when the whole block is absent), mirroring the
 * steeringConfigSchema / agentSteeringOverrideSchema split. `enforced`
 * stays tri-state `.optional()` — the prefix-rule default
 * (fin-/acme-) must keep applying when it is omitted.
 */
export const verificationDefaultsSchema = z.object({
  enforced: z.boolean().optional(),
  maxVerifyHops: z
    .number()
    .int()
    .min(0)
    .max(2)
    .default(VERIFICATION_BUDGET_DEFAULTS.maxVerifyHops),
  skipIfTurnMsOver: z
    .number()
    .int()
    .min(5_000)
    .default(VERIFICATION_BUDGET_DEFAULTS.skipIfTurnMsOver),
  shrinkIfTurnMsOver: z
    .number()
    .int()
    .min(1_000)
    .default(VERIFICATION_BUDGET_DEFAULTS.shrinkIfTurnMsOver),
  deferMs: z
    .number()
    .int()
    .min(0)
    .max(30_000)
    .default(VERIFICATION_BUDGET_DEFAULTS.deferMs),
  /**
   * 999.63b — rule-claim class defaults surface. `.default()`s single-
   * sourced from VERIFICATION_BUDGET_DEFAULTS.ruleClaims
   * ({enabled: true, maxVerifyHops: 0} = fleet-wide SHADOW: classify +
   * telemetry everywhere the gate is enforced, corrective hop for the
   * rules class only where an operator raises maxVerifyHops).
   */
  ruleClaims: z
    .object({
      enabled: z
        .boolean()
        .default(VERIFICATION_BUDGET_DEFAULTS.ruleClaims.enabled),
      maxVerifyHops: z
        .number()
        .int()
        .min(0)
        .max(2)
        .default(
          VERIFICATION_BUDGET_DEFAULTS.ruleClaims.maxVerifyHops,
        ),
    })
    .optional(),
  /**
   * C (2026-08-26) — hold-mode defaults surface. `.default()`s single-
   * sourced from VERIFICATION_BUDGET_DEFAULTS (false / 45 s):
   * the fleet stays post-hoc unless an agent opts in.
   */
  holdDelivery: z
    .boolean()
    .default(VERIFICATION_BUDGET_DEFAULTS.holdDelivery),
  holdTimeoutMs: z
    .number()
    .int()
    .min(5_000)
    .max(120_000)
    .default(VERIFICATION_BUDGET_DEFAULTS.holdTimeoutMs),
  /**
   * 999.63d — verified-streaming UX defaults surface. `.default()`s
   * single-sourced from VERIFICATION_BUDGET_DEFAULTS.ux (all
   * false — every knob is per-agent opt-in).
   */
  /** 999.63d/6 — fleet-default topic. */
  topic: z
    .object({
      profile: z.enum(["finance", "legal", "none"]).default("finance"),
      extraTerms: z.array(z.string().min(1).max(64)).max(40).default([]),
    })
    .optional(),
  ux: z
    .object({
      streamStatus: z
        .boolean()
        .default(VERIFICATION_BUDGET_DEFAULTS.ux.streamStatus),
      streamStatusMode: z
        .enum(["always", "topic", "auto"])
        .default(VERIFICATION_BUDGET_DEFAULTS.ux.streamStatusMode),
      narrationAsTrail: z
        .boolean()
        .default(VERIFICATION_BUDGET_DEFAULTS.ux.narrationAsTrail),
      sourcesFooter: z.enum(["off", "claims", "always"]).default(VERIFICATION_BUDGET_DEFAULTS.ux.sourcesFooter),
      verdictReactions: z.boolean().default(VERIFICATION_BUDGET_DEFAULTS.ux.verdictReactions),
      modelSourcesLine: z.enum(["keep", "strip", "flag"]).default(VERIFICATION_BUDGET_DEFAULTS.ux.modelSourcesLine),
      ledgerButton: z.boolean().default(VERIFICATION_BUDGET_DEFAULTS.ux.ledgerButton),
      ledgerReaction: z.string().max(8).default(VERIFICATION_BUDGET_DEFAULTS.ux.ledgerReaction),
      liveClaims: z.boolean().default(VERIFICATION_BUDGET_DEFAULTS.ux.liveClaims),
      statusMessage: z.enum(["inline", "separate"]).default(VERIFICATION_BUDGET_DEFAULTS.ux.statusMessage),
      unverifiedNotice: z.boolean().default(VERIFICATION_BUDGET_DEFAULTS.ux.unverifiedNotice),
      compactBelowChars: z.number().int().min(0).max(2000).default(VERIFICATION_BUDGET_DEFAULTS.ux.compactBelowChars),
      sourcesCharBudget: z.number().int().min(80).max(1500).default(VERIFICATION_BUDGET_DEFAULTS.ux.sourcesCharBudget),
      pendingMarker: z
        .boolean()
        .default(VERIFICATION_BUDGET_DEFAULTS.ux.pendingMarker),
      verifiedBadge: z
        .boolean()
        .default(VERIFICATION_BUDGET_DEFAULTS.ux.verifiedBadge),
    })
    .optional(),
});

/**
 * Phase 135 — per-agent voice channel config.
 *
 * `deepgramKey` / `elevenLabsKey` accept either raw secrets or `op://`
 * URIs (pre-resolved at boot via `SecretsResolver.preResolveAll`; the
 * secrets-collector Zone 5 walker scoops both into the warm-up set).
 *
 * `voiceId` is the per-agent ElevenLabs voice identifier (no enum — too
 * many possible IDs to enumerate; bad IDs surface as 404s from the TTS
 * call site in Plan 02).
 *
 * `monthlyMinutesCap` is an OPTIONAL soft cap (1..100_000 inclusive).
 * Omitted = no cap. Plan 03 wires the runtime tracker that disconnects
 * the session + posts a warning when the cap is hit.
 *
 * Phase 135 REVIEW WR-05 — cap semantics clarification: the cap counts
 * approximate-minutes-of-spoken-audio (TTS) + approximate-minutes-of-
 * transcribed-audio (STT). The TTS side is approximated from synthesis
 * input text length (≈15 chars/s of English conversational pace) rather
 * than ElevenLabs' actual char-count billing — dense text (URLs,
 * addresses) takes longer to speak per character than conversational
 * text, so cap accounting may under-count by ~20–30% in those cases.
 * MVP-acceptable as a SOFT cap (the ±10% drift framing in the prior
 * paragraph extends here). A v3.0.1 polish pass may switch to a
 * two-axis cap (monthlyCharCapTts + monthlySecondsCapStt) that maps
 * cleanly onto ElevenLabs (chars) + Deepgram (seconds) actual billing.
 *
 * The whole block is `.optional()` on `agentSchema.voice` (voice is
 * opt-in per agent per CONTEXT.md). Mirrors the Phase 117 `advisor`
 * optionality pattern.
 */
export const voiceConfigSchema = z.object({
  channelId: z.string().min(1).optional(),
  deepgramKey: z.string().min(1),
  elevenLabsKey: z.string().min(1),
  voiceId: z.string().min(1),
  promptSuffix: z.string().min(1).optional(),
  monthlyMinutesCap: z.number().int().min(1).max(100_000).optional(),
  /**
   * Phase 135.0.1 — opt-in auto-join on daemon boot.
   * When false/unset, the agent does NOT auto-join its configured
   * channelId on startup. `/vc join` (manual invocation in the agent's
   * text channel) still works. Default false so multi-agent fleets
   * can share a single voice channelId without all agents joining
   * the channel at boot (which would cause cross-agent speaker
   * collision since 135.3 speaker-context isn't implemented yet).
   */
  autoJoin: z.boolean().optional(),
  /**
   * 999.116 hotfix — join the configured voice channel automatically when a
   * HUMAN joins it, and leave when the last human leaves. Default true (the
   * north-star UX: the agent is there when you are). `/vc join` / `/vc leave`
   * still work. Set false for manual-only. Bots never trigger it.
   */
  autoJoinOnUser: z.boolean().optional(),
  /**
   * 999.116 hotfix — short greeting spoken right after the bot joins
   * (default "I'm listening."). It proves the TTS + encrypted send path on
   * every join and tells the user the agent is actually there. "" disables.
   */
  joinGreeting: z.string().max(200).optional(),
  /**
   * Phase 135 Plan 03 — silence-fallback timer window in milliseconds.
   * When an agent doesn't respond within this window after a voice
   * transcript fires, a one-shot Haiku response is synthesised and
   * spoken (no dead air). Defaults to 30_000 ms (see
   * `DEFAULT_SILENCE_FALLBACK_MS` in
   * `src/discord/voice/silence-fallback.ts`). Clamped to 5s..120s.
   */
  silenceFallbackMs: z.number().int().min(5000).max(120_000).optional(),
  /**
   * DEPRECATED (999.116, 2026-09-02) — INERT, no code reads this.
   *
   * It selected the direct-vs-bridge route for the Haiku silence-fallback
   * LLM call. 999.116 replaced that fallback with a generic progress cue
   * (`fireProgressCue`) that makes no LLM call, so there is no route to
   * choose. Retained (accepted, not required) only so existing yaml that
   * sets it doesn't fail validation; ignored at runtime. Remove once no
   * prod agent still declares it. Kept explicitly rather than silently
   * dropped to avoid a fresh instance of the "yaml declares keys the code
   * ignores" trap (999.116 G2).
   */
  silenceFallbackRoute: z.enum(["bridge", "direct"]).optional(),
  /**
   * Phase 135.4 — VAD utterance end window in milliseconds.
   * Time of silence Deepgram waits before finalising a transcript.
   * Plan 02 hardcoded 1000ms which produced premature finals on natural
   * pauses; Plan 04 raised the default to 1500ms and exposed the knob.
   * Phase 135.1 — floor lowered 1000→500 so low-latency configs (paired
   * with semantic `speech_final` dispatch + barge-in recovery) can push
   * turn-end detection faster than the conservative default. Clamped to
   * 500..5000ms. `undefined` => use stt.ts default (DEFAULT_UTTERANCE_END_MS),
   * so the fleet picks up new defaults without yaml churn.
   */
  utteranceEndMs: z.number().int().min(500).max(5000).optional(),
  /**
   * Phase 135.4 — Deepgram endpointing window in milliseconds.
   * Voice-activity-aware silence threshold (different signal than the
   * wall-clock utterance_end_ms). Combining both reduces premature
   * finalisation on breaths/pauses. Default 1000ms (Phase 135 REBUILD raised
   * from 500 to stop mid-sentence speech_final). Clamped to 100..2000.
   */
  endpointingMs: z.number().int().min(100).max(2000).optional(),
  /**
   * Phase 135.4 — Minimum Deepgram confidence to dispatch a final
   * transcript as a turn. Drops background noise (low-confidence
   * "uh", "hm", crowd murmur). Default 0.6. Clamped to 0..1.
   */
  minConfidence: z.number().min(0).max(1).optional(),
  /**
   * Phase 135.4 — Minimum word count for a final transcript to dispatch.
   * Drops single-word backchannels ("yeah", "okay") that aren't intended
   * as agent turns. Default 2. Clamped to 1..10.
   */
  minWordCount: z.number().int().min(1).max(10).optional(),
  /**
   * Phase 135 REBUILD — nova-3 keyterm prompting. Proper nouns / the agent's
   * spoken name to boost recognition (e.g. fixes "Clawdy" → "Claudia"). Each
   * entry becomes a `keyterm` query param on the Deepgram stream. nova-3 only
   * (the legacy `keywords` param is unsupported on nova-3). Omit/empty = none.
   */
  keyterms: z.array(z.string().min(1)).optional(),
  /**
   * Phase 135.5 — opt-in: post each voice turn (user transcript + agent
   * reply) to the agent's primary text channel for visibility. Default
   * false. When true, every voice turn produces a paired
   * `🎙️ **<displayName>:** <transcript>` + `💬 **<agentName>:** <reply>`
   * pair posted to `agentConfig.channels[0]`. Failures don't block the
   * voice turn — text-channel posts are observability, not primary
   * delivery. Suppressed for the agent-half when the silence-fallback
   * fired (the agent's reply was deliberately not spoken).
   */
  transcriptToChannel: z.boolean().optional(),
  /**
   * Phase 135.1 — barge-in (interrupt-the-agent) tuning. When enabled, a
   * user speaking while the agent is talking pauses playback within ~150ms
   * (Discord speaking event), then a Deepgram interim confirms a real
   * interrupt (aborts the turn + audio) or a backchannel ("mm-hm") rolls
   * back and playback resumes. Default disabled — flip `enabled: true` per
   * agent for canary rollout. Sub-fields fall through to in-code defaults
   * (turn-state.ts DEFAULT_BARGEIN_*) when omitted.
   */
  bargeIn: z
    .object({
      enabled: z.boolean().default(false),
      /** Rollback window when no interim confirms the interrupt. 500..5000ms. */
      falseInterruptTimeoutMs: z.number().int().min(500).max(5000).optional(),
      /** Non-backchannel word count that commits an interrupt. 1..6. */
      minConfirmWords: z.number().int().min(1).max(6).optional(),
      /** Quiet period after a confirmed interrupt before the agent speaks. 0..3000ms. */
      backoffMs: z.number().int().min(0).max(3000).optional(),
    })
    .optional(),
  /**
   * Phase 135.1 Phase 4 — sentence-streamed TTS over the ElevenLabs
   * multi-context WebSocket (speak after the first sentence instead of the
   * whole response). Default disabled; the HTTP `speakResponse` path is the
   * proven fallback (also used automatically if the WS fails to open).
   * `outputFormat` default pcm_24000 (tier-safe, resampled to 48k stereo for
   * StreamType.Raw — ffmpeg-free, deterministic framing).
   */
  streamingTts: z
    .object({
      enabled: z.boolean().default(false),
      outputFormat: z
        .enum(["pcm_24000", "opus_48000_64", "mp3_44100_128"])
        .optional(),
    })
    .optional(),
  /**
   * Phase 135.1 Phase 5 — STT engine selection. "nova3" (default) is the
   * shared-WS silence-endpointing path (stt.ts). "flux" opens one Deepgram Flux
   * (v2) connection per speaker for ~260ms turn-native end-of-turn detection and
   * true per-speaker attribution. eotThreshold tunes end-of-turn confidence
   * (higher = more patient); eagerEotThreshold (unset = off) enables speculative
   * dispatch; maxConcurrentConnections caps per-session Flux sockets.
   */
  stt: z
    .object({
      engine: z.enum(["nova3", "flux"]).optional(),
      eotThreshold: z.number().min(0.5).max(0.9).optional(),
      eagerEotThreshold: z.number().min(0.3).max(0.9).optional(),
      maxConcurrentConnections: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
});

export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

/**
 * Per-agent OS-sandbox (bubblewrap) config. When `enabled`, the agent's `claude`
 * process is wrapped in a bwrap mount namespace confining it to its own
 * workspace (FS isolation; see `src/manager/bwrap-sandbox.ts`). Admin agents are
 * exempt regardless (the `admin` flag short-circuits at the wrapper). The
 * resolved value is captured into the spawn at boot → NON_RELOADABLE; flips
 * need `clawcode restart <agent>`. `allowRuntimeOp` keeps the `op` CLI +
 * `OP_SERVICE_ACCOUNT_TOKEN` available inside the sandbox for agents whose
 * skills call `op read` at runtime (otherwise the fleet vault token is stripped
 * from the sandboxed env). Default OFF — deploying the feature changes nothing.
 */
export const sandboxConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    allowRuntimeOp: z.boolean().default(false),
  })
  .strict();

/**
 * Per-agent VOICE profile for the OpenAI endpoint (`/v1/chat/completions`).
 *
 * Opt-in (default OFF). When `enabled`, an OpenAI-route turn for this agent
 * runs the FULL agent session (workspace cwd + assembled identity/skills/MCP
 * prompt + tools + memory + effort) instead of the stateless soul-only
 * transient — but OPTIMIZED FOR LOW LATENCY via the override knobs below
 * (they cascade over the agent's normal config; unset → inherit). It also
 * switches the SSE stream into enhanced mode (≤8s idle-watchdog heartbeat +
 * status/tool events). Absent/disabled → today's stateless + 15s behavior,
 * byte-identical for every other agent/consumer.
 */
export const openaiVoiceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Idle-heartbeat cadence. Must be ≤ the client's 8s inter-token watchdog.
  streamKeepaliveMs: z.number().int().min(1000).max(8000).default(5000),
  // Voice-only overrides (cascade over the agent's base config; unset = inherit).
  effort: effortSchema.optional(),
  // Curated MCP server allowlist by name — REQUIRED to expose any tools to a
  // voice session. SAFE DEFAULT: omitted = NO tools (the voice full-session is an
  // internet-facing bypassPermissions surface — never auto-expose write/DB
  // servers like acme-db). `[names…]` = only those servers. Also trims
  // tool-list tokens + startup for latency.
  mcpAllowlist: z.array(z.string()).optional(),
  memoryRetrievalTopK: z.number().int().min(0).max(50).optional(),
  memoryRetrievalTokenBudget: z.number().int().min(0).max(8000).optional(),
  memoryAutoLoad: z.boolean().optional(),
});
export type OpenaiVoiceConfig = z.infer<typeof openaiVoiceConfigSchema>;

/**
 * Schema for a single agent entry in the config.
 * Channel IDs are strings to prevent YAML numeric coercion (Pitfall 1).
 */
/**
 * Phase 999.128 — one named workflow template. Prompts (and step ids) may
 * use `{{param}}` placeholders; every placeholder must be declared in
 * `params`. Exactly one of `steps` / `waves`, same caps as start_workflow
 * (validated at launch through normalizeWorkflowSpec).
 */
const workflowTemplateStepSchema = z.object({
  stepId: z.string().min(1),
  prompt: z.string().min(1),
  mcpServers: z.array(z.string().min(1)).optional(),
});
const workflowTemplateSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/),
  description: z.string().optional(),
  params: z
    .array(
      z.object({
        name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]*$/),
        description: z.string().optional(),
        default: z.string().optional(),
      }),
    )
    .optional(),
  steps: z.array(workflowTemplateStepSchema).min(1).max(8).optional(),
  waves: z.array(z.array(workflowTemplateStepSchema).min(1).max(8)).min(1).max(6).optional(),
});

/**
 * Phase 999.161/999.164 — per-agent fast lane. Exported so the loader can fill
 * the defaults for an agent with no `fastLane:` block: the lane is ON for every
 * agent by default (Operator, 2026-09-23), and `/clawcode-quick` overrides per agent.
 */
export const fastLaneSchema = z.object({
  enabled: z.boolean().default(true),
  /** Model for the quick answer. */
  model: z.enum(["haiku", "sonnet"]).default("haiku"),
  /**
   * Quick-answer deadline; timeout → task lane. v1.1: one haiku-direct call
   * (a fresh CLI spawn with trimmed startup), 2.3–6 s measured on clawdy.
   * The v1 classifier call and its `classifierTimeoutMs` / `minConfidence`
   * knobs are gone — unknown keys in yaml are ignored, not rejected.
   */
  answerTimeoutMs: z.number().int().min(1_000).max(60_000).default(15_000),
  maxTokens: z.number().int().min(64).max(2_000).default(500),
  /** Longer messages are never quick. */
  maxMessageChars: z.number().int().min(20).max(2_000).default(400),
  /**
   * Phase 999.164 — extra words/phrases that always mean "task lane" for this
   * agent (whole words, case-insensitive), on top of the domains derived from
   * its MCP servers and skills. E.g. a project codename.
   */
  taskTopics: z.array(z.string().trim().min(2).max(80)).max(200).optional(),
});

/**
 * Phase 999.171 — shared per-agent UX toggles. Every flag defaults OFF
 * fleet-wide (the loader resolves an omitted block to three `false`s), and
 * `/clawcode-ux` layers a persisted runtime override on top
 * (ux-feature-state.json, re-applied at boot).
 *
 * - liveThinking: render-only (thinking progress in the status trail), read
 *   per message by the bridge, so it is RELOADABLE.
 * - statusPing (999.178 R1): the daemon answers a short check-in ("eta",
 *   "we good?") from the live trail with no model turn. Read per message by
 *   the bridge, so it is RELOADABLE like liveThinking.
 * - promptSuggestions / researchSubagents: session-start options consumed by
 *   999.172 / 999.173. Declared and stored here but INERT in 999.171; edits
 *   are restart-required.
 *
 * Not `.strict()`: like fastLaneSchema, unknown keys are ignored (stripped),
 * so one yaml typo cannot fail the whole config load at boot.
 */
export const uxFeaturesSchema = z.object({
  liveThinking: z.boolean().optional(),
  statusPing: z.boolean().optional(),
  promptSuggestions: z.boolean().optional(),
  researchSubagents: z.boolean().optional(),
});

/**
 * Phase 999.173 — research-subagent knobs. Every field is optional; the
 * defaults live in src/manager/research-subagents.ts (sonnet, medium effort,
 * 25 turns, 4 concurrent, 20-min hold). Read at session start, so an edit is
 * restart-required. Only meaningful when `uxFeatures.researchSubagents` is on.
 * Not `.strict()` (a yaml typo must not fail the whole config load).
 */
export const researchSchema = z.object({
  model: z.enum(["sonnet", "opus", "haiku", "fable", "inherit"]).optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  maxTurns: z.number().int().min(1).max(200).optional(),
  maxConcurrent: z.number().int().min(1).max(4).optional(),
  holdTimeoutMinutes: z.number().int().min(1).max(120).optional(),
  /** Explicit researcher tool list; omitted = inherit the agent's tools (minus the side-effect denylist). */
  tools: z.array(z.string().min(1)).optional(),
  /** Extra exact tool names (or `mcp__<server>`) denied to researchers, on top of the built-in denylist. */
  deniedTools: z.array(z.string().min(1)).optional(),
  /** Let researchers use Bash (curl / pdftotext / python for numbers). Default false. */
  allowBash: z.boolean().optional(),
  /** Tool calls per researcher before a hard stop (nudge at 80 %). Default 60. */
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  /** Tool calls across all of one request's researchers (nudge at 80 %). Default 180. */
  maxSessionToolCalls: z.number().int().min(1).max(3000).optional(),
  /** Wall-clock minutes per researcher before it is stopped. Default 15. */
  maxMinutes: z.number().int().min(1).max(120).optional(),
  /** Usage-aware launch guard: ≥ reduceAt → 1 researcher per request; ≥ blockAt → none. */
  usageGuard: z
    .object({ reduceAt: z.number().min(0).max(1).optional(), blockAt: z.number().min(0).max(1).optional() })
    .optional(),
  /**
   * Route research requests to researchers (2026-09-26, Client A's agents). When
   * true: a Discord message asking for a deep dive / research / a workflow
   * gets a per-turn steer to use researcher subagents, and a research-only
   * `start_workflow` from a live Discord turn is denied with a pointer to
   * researchers. Default false. See research-route.ts.
   */
  autoRoute: z.boolean().optional(),
});

export const agentSchema = z.object({
  name: z.string().min(1),
  /**
   * Phase 999.117 WS-5 — additional names this agent answers to for
   * agent-to-agent addressing (`post_to_agent` / `ask_agent` `to:`).
   *
   * Exists because agent names are operator-chosen display strings, and one
   * production agent is named "Admin Clawdy" — space AND capitals, in a fleet
   * where every other name is kebab-case. `to: "admin"` was the natural guess
   * and failed. An alias is a STATED intent, so it is matched before any
   * fuzzy normalisation.
   *
   * Aliases must be unique across the fleet; an ambiguous match resolves to
   * nothing rather than picking one (silently delivering to the wrong agent
   * is far worse than failing, because nobody can tell).
   */
  aliases: z.array(z.string().min(1)).optional(),
  workspace: z.string().optional(),
  // Phase 75 SHARED-01 — per-agent override for the directory that owns
  // this agent's private runtime state (memories.db, traces.db, inbox/,
  // heartbeat.log, context-summary files). When unset, loader.ts falls
  // back to `workspace`. Enables multiple agents (e.g., the acme family)
  // to share one basePath while keeping memory/inbox/heartbeat isolated.
  // Raw string — expansion via expandHome() happens in loader.ts (Plan 02).
  memoryPath: z.string().min(1).optional(),
  channels: z.array(z.string()).default([]),
  /**
   * Multi-platform messaging phase — optional Slack binding for this agent.
   * `channels` are Slack channel ids (e.g. "C0ABC123"). The optional identity
   * fields drive the per-message `username`/`icon_*` masquerade so each agent
   * keeps its own face on a single shared Slack app; when omitted the agent's
   * `name` is used as the display name. Requires root `slack:` credentials.
   * See .planning/multi-platform-messaging-PLAN.md.
   */
  slack: z
    .object({
      channels: z.array(z.string()).default([]),
      displayName: z.string().min(1).optional(),
      iconUrl: z.string().url().optional(),
      iconEmoji: z.string().min(1).optional(),
    })
    .optional(),
  model: modelSchema.optional(),
  // Phase 86 MODEL-01 — per-agent allowlist for /clawcode-model picker.
  // Additive + optional: v2.1 migrated configs (15 agents) parse
  // unchanged; the loader's resolver fills defaults.allowedModels when
  // this is omitted. Each entry must be a valid modelSchema alias —
  // unknown aliases are rejected at parse time. Max 25 enforced
  // downstream (Discord StringSelectMenuBuilder cap in Plan 03).
  allowedModels: z.array(modelSchema).optional(),
  // Phase 89 GREET-07 — per-agent override for restart-greeting emission.
  // Additive + optional: v2.1 migrated configs parse unchanged when omitted;
  // loader resolver fills from defaults.greetOnRestart. Reloadable.
  greetOnRestart: z.boolean().optional(),
  // Phase 89 GREET-10 — per-agent override for in-memory cool-down window (ms).
  // Additive + optional; resolver falls back to defaults.greetCoolDownMs.
  greetCoolDownMs: z.number().int().positive().optional(),
  // Phase 90 MEM-01 — Auto-load workspace MEMORY.md into the v1.7
  // stable prefix at session boot (AFTER IDENTITY, BEFORE MCP status).
  // Additive + optional: v2.1 migrated configs parse unchanged; loader
  // resolver fills from defaults.memoryAutoLoad when omitted. Reloadable
  // per D-18 — next session boot picks up a YAML edit. 50KB hard cap
  // enforced downstream in session-config.ts (MEMORY_AUTOLOAD_MAX_BYTES).
  memoryAutoLoad: z.boolean().optional(),
  // Phase 90 MEM-01 — Override default MEMORY.md path (absolute or ~/...).
  // When unset, session-config.ts reads `{workspace}/MEMORY.md`. Raw
  // string here; expansion via expandHome() happens in loader.ts.
  memoryAutoLoadPath: z.string().min(1).optional(),
  // Phase 90 MEM-03 — per-agent override for the hybrid-RRF top-K. When
  // omitted, resolver falls back to defaults.memoryRetrievalTopK (5 per
  // D-RETRIEVAL). Reloadable (next turn picks up the new value).
  memoryRetrievalTopK: z.number().int().positive().max(50).optional(),
  /**
   * Phase 999.124 — append "— recalled N memories (dates)" under replies
   * whose turn received a <memory-context> block. Overrides
   * `defaults.memoryRecallFooter`. Reloadable (next turn).
   */
  memoryRecallFooter: z.boolean().optional(),
  /**
   * Phase 999.133 — where the recalled memory shows: `button` (default; the
   * 🧾 Sources button + card, shared with the verification ledger) or
   * `footer` (the italic line, itemised in verbose channels).
   */
  memoryRecallDisplay: z.enum(["button", "footer"]).optional(),
  /**
   * Phase 999.127 — weekly "what I learned about you" digest posted to the
   * agent's channel (Mondays 09:00 Pacific by default; number reactions
   * forget an item, 👍 confirms them all). `enabled: false` opts out.
   */
  memoryDigest: z.object({ enabled: z.boolean().optional() }).optional(),
  // Phase 127 — per-agent stream-stall supervisor threshold (ms). When
  // the SDK iteration loop sees no useful content tokens (text_delta or
  // input_json_delta.partial_json) for this many milliseconds, the
  // current turn is aborted via AbortController and a structured
  // `phase127-stream-stall` log line is emitted. Optional here; resolver
  // fills from `defaults.modelOverrides[agent.model].streamStallTimeoutMs`
  // first, then `defaults.streamStallTimeoutMs` (180000ms baseline).
  // Reloadable — the stall-check setInterval re-reads the threshold on
  // each tick, so a YAML edit applies within Math.min(threshold/4, 30000)ms.
  // Range 30000-1800000ms (30s — 30min) to bound foot-guns.
  streamStallTimeoutMs: z.number().int().min(30_000).max(1_800_000).optional(),
  // Phase 145 WS2 — per-agent override for the ABSOLUTE turn-duration
  // ceiling (stream-stall-tracker `DEFAULT_MAX_TURN_DURATION_MS` = 20 min,
  // the watchdog of last resort that fires regardless of activity/pause).
  // Long-running background workers (the daemon-side workflow orchestrator)
  // need a LIFTED ceiling so a legitimately-long worker turn is not aborted.
  // Cascade mirrors streamStallTimeoutMs exactly:
  //   agent.maxTurnDurationMs ??
  //   defaults.modelOverrides[agent.model].maxTurnDurationMs ??
  //   defaults.maxTurnDurationMs (then the 20-min built-in).
  // min == the existing 20-min default (1_200_000) so an operator can only
  // ever LIFT, never lower, the ceiling (a lowered ceiling would re-introduce
  // the very watchdog trips WS2 designs out). max is a large FINITE value
  // (8h = 28_800_000) — the tracker constructor rejects 0/Infinity via its
  // `Number.isFinite(maxTurnDurationMs) && maxTurnDurationMs > 0` guard
  // (stream-stall-tracker.ts:378), so the ceiling can never be disabled.
  // Reloadable — the tracker re-reads per turn (Plan 03 wires the read).
  maxTurnDurationMs: z.number().int().min(1_200_000).max(28_800_000).optional(),
  // Phase 145 WS1 — per-agent flag gating the subagent PreToolUse
  // permission hook (Plan 02). When true, the SDK adapter registers a
  // deterministic hook that auto-allows the working tool set + auto-denies
  // the prompting WebFetch tool, so in-process Workflow/Agent subagents
  // (which do NOT inherit the parent's bypassPermissions) never hang on a
  // headless permission prompt. Default OFF (resolver `?? false`) keeps the
  // existing fleet byte-identical; this plan only declares + resolves it.
  subagentPermissionGate: z.boolean().optional(),
  // WS-1 (999.99 structural delivery) — per-agent delivery block. Currently
  // one knob: `attributedStream` gates the turn-attributed SDK stream demux
  // (self-fired turn output delivers immediately instead of buffering into
  // the next inbound reply — the 2026-07-15/16 off-by-N incident class).
  // Cascade: agent ?? defaults ?? false. NON-RELOADABLE — read at session
  // spawn; a flip needs a daemon restart (same as disallowedTools). Canary
  // rollout: enable per-agent first (Admin Clawdy), then defaults.
  delivery: z
    .object({
      attributedStream: z.boolean().optional(),
    })
    .optional(),
  // Phase 115 sub-scope 3 — per-agent override for the per-turn
  // <memory-context> token budget. When omitted, resolver falls back to
  // defaults.memoryRetrievalTokenBudget (1500 per Phase 115 D-02). Range
  // 500-8000. Reloadable — next turn picks up the new value via the
  // getMemoryRetrieverForAgent closure re-read.
  memoryRetrievalTokenBudget: z.number().int().min(500).max(8000).optional(),
  // Phase 115 sub-scope 4 — per-agent override for the tag-exclusion list
  // applied at hybrid-RRF retrieval. When omitted, resolver falls back to
  // defaults.memoryRetrievalExcludeTags (locked default ["session-summary",
  // "mid-session", "raw-fallback"] per CONTEXT.md sub-scope 4). Empty array
  // disables filtering entirely; a populated array replaces (does NOT merge
  // with) the defaults. Reloadable.
  memoryRetrievalExcludeTags: z.array(z.string()).optional(),
  // Phase 115 sub-scope 2 — per-agent override for the SDK
  // systemPrompt.excludeDynamicSections flag. When omitted, resolver falls
  // back to defaults.excludeDynamicSections (default true). Set false to
  // restore pre-115 behavior (dynamic sections like cwd/env/git remain
  // inside the system prompt rather than re-injected as the first user
  // message). Reload classification: NEXT-SESSION only — the systemPrompt
  // option is captured in baseOptions at session create/resume.
  excludeDynamicSections: z.boolean().optional(),
  // Phase 115 sub-scope 5 (Plan 04) — per-agent override for the
  // cache-breakpoint placement mode. When omitted, resolver falls back to
  // `defaults.cacheBreakpointPlacement` (default "static-first"). Set
  // "legacy" to revert to pre-115 interleaved stable-prefix ordering with
  // NO breakpoint marker — operator-controlled rollback path. Reload
  // classification: NEXT-SESSION only — placement is captured into the
  // assembled stable prefix at session create/resume.
  cacheBreakpointPlacement: z.enum(["static-first", "legacy"]).optional(),
  // Phase 90 MEM-02 — per-agent gate for the chokidar scanner. Default true
  // (via defaults.memoryScannerEnabled). Set to false to skip scanner start
  // for an agent whose memory/ is managed externally.
  memoryScannerEnabled: z.boolean().optional(),
  // Phase 90 MEM-04 — per-agent override for the mid-session flush cadence
  // in milliseconds (D-26). When omitted, resolver falls back to
  // defaults.memoryFlushIntervalMs (15 min). Positive integer only —
  // set defaults to a huge value (e.g. 24h) to effectively disable.
  memoryFlushIntervalMs: z.number().int().positive().optional(),
  // Phase 90 MEM-05 — per-agent override for the ✅ reaction emoji posted
  // on cue-detection (D-32). Short string (1–4 chars so a single unicode
  // glyph or short custom emoji name fits). Fallback via
  // defaults.memoryCueEmoji.
  memoryCueEmoji: z.string().min(1).max(8).optional(),
  // Phase 999.43 D-09 — per-agent gate for auto-ingest of Discord
  // attachments. DEFAULT FALSE FLEET-WIDE per D-09 — existing agents
  // without the flag preserve current behavior (manual `ingest_document`
  // MCP tool only). Operator opts in per-agent via `clawcode.yaml` edit
  // + `clawcode reload`. Additive + optional; resolver falls back to
  // defaults.autoIngestAttachments (zod default false). Reloadable —
  // read LAZILY on each `attachmentReceived` event (Plan 02 dispatcher
  // reads via SessionManager.getAgentConfig at receive time — no cached
  // session-boot capture). Mirrors the Phase 90 MEM-03 closure-re-read
  // pattern (types.ts:78-83). 12th application of the additive-optional
  // reloadable blueprint (Phase 83/86/89/90/94/95/96/110/115/117/127).
  autoIngestAttachments: z.boolean().optional(),
  // Phase 999.43 D-01 Axis 1 — per-agent base priority multiplier for
  // auto-ingested documents. Three-level enum:
  //   - high   → 1.5× score multiplier at retrieval time
  //   - medium → 1.0× (no-op)
  //   - low    → 0.7×
  // Multiplies into the final score per D-02:
  //   score = base × agent_priority_weight × content_priority_weight × recency_boost
  // Optional + back-compat: when omitted, loader resolver falls back to
  // defaults.ingestionPriority (zod default "medium"). Reloadable —
  // same closure-re-read path as autoIngestAttachments above.
  ingestionPriority: z.enum(["low", "medium", "high"]).optional(),
  // Phase 132 D-08 — per-agent gate for autonomous skill drafting (Hermes
  // pattern). DEFAULT OFF FLEET-WIDE per D-08 — existing agents without
  // the flag preserve current behavior (no `task.completed` event emit,
  // no distiller spawn). Operator opts in per-agent via `clawcode.yaml`
  // edit + `clawcode reload`. Additive + optional; resolver in Plan 02
  // falls back to defaults.autonomousSkillDrafting (zod default false).
  // Reloadable — read LAZILY at task-completion event emit time via
  // SessionManager.getAgentConfig. Mirrors the Phase 999.43
  // autoIngestAttachments closure-re-read pattern at schema.ts:1369.
  // 13th application of the additive-optional reloadable blueprint.
  autonomousSkillDrafting: z.boolean().optional(),
  // Phase 132 D-03 — per-agent eligibility threshold overrides for the
  // out-of-band skill distiller. Each inner field is optional; the
  // resolver merges with defaults.skillDistiller (resolved defaults:
  // minToolCalls=5, minDurationMs=180_000, outcomeFilter=["success"];
  // minToolCalls lowered 6→5 by Phase 999.42 capability B / CONTEXT D4).
  // `distillerModel` per D-02 — operator can escalate to sonnet if
  // haiku-quality drafts are insufficient during the 2-week Admin
  // Clawdy trial cohort. Additive + optional; back-compat preserved
  // (omission resolves to the defaults block via Plan 02 loader edits).
  // Phase 999.42 capability C / CONTEXT D7 — `suggestPatches` gates the
  // distiller patch-suggest path: when true AND a recurring trajectory's
  // fingerprint matches an active skill's `originatingFingerprint`, the
  // distiller emits a `skill-patches/` patch artifact (Haiku refine mode)
  // instead of a duplicate create-draft. DEFAULT OFF — the fleet sees zero
  // behavior change until an operator opts an agent in. Additive + optional;
  // reloadable like `autonomousSkillDrafting` (read LAZILY at distiller-
  // dispatch time via the closure-re-read blueprint — 14th application).
  skillDistiller: z
    .object({
      minToolCalls: z.number().int().positive().optional(),
      minDurationMs: z.number().int().positive().optional(),
      outcomeFilter: z
        .array(z.enum(["success", "partial", "failed"]))
        .nonempty()
        .optional(),
      distillerModel: z.enum(["haiku", "sonnet"]).optional(),
      suggestPatches: z.boolean().optional(),
    })
    .optional(),
  /**
   * Phase 100 follow-up — when true, the agent boots automatically on
   * daemon start-all. When false, the agent's config is loaded but the SDK
   * session is NOT created on boot — operator can start it manually via
   * `clawcode start <name>` or via the IPC `start` method.
   *
   * Use case: large fleets where only a subset are in active rotation.
   * Configured agents that are dormant (rare-use specialists, on-call
   * agents, archived) skip the warm-path warmup at boot, cutting cold-start
   * time for the whole fleet from O(N agents × 2-3s) to O(active agents ×
   * 2-3s).
   *
   * Optional + back-compat: when omitted, loader.ts falls back to
   * defaults.autoStart (zod default true). v2.5/v2.6 yaml configs parse
   * unchanged. Mirrors the additive-optional schema blueprint used by
   * memoryAutoLoad / memoryScannerEnabled / greetOnRestart — agent fields
   * stay `.optional()` so the loader can detect "operator omitted" and
   * fall back to defaults.X verbatim.
   *
   * Reload classification: next-boot only. startAll has already run by the
   * time a config-watcher reload would fire, so flipping this field
   * requires a daemon restart to take effect.
   */
  autoStart: z.boolean().optional(),
  /**
   * Phase 110 Stage 0b — per-agent shimRuntime override. Mirrors the
   * shape of `defaultsSchema.shimRuntime` but each field is optional so
   * the loader can fall through (per-agent → defaults → "static") without
   * forcing operators to specify all three types when overriding one.
   *
   * Use case: per-agent canary rollout. Set
   * `agents.<name>.shimRuntime.search: static` to flip ONE agent to the
   * Go binary while the rest of the fleet stays on Node. Survives
   * agent-restart (loader re-resolves on every spawn) which the prior
   * inline-mcpServers-override workaround did not.
   *
   * Each field accepts the same enum as defaults.shimRuntime:
   *   - "node":   per-agent `clawcode <type>-mcp` (Node, ~147 MB RSS)
   *   - "static": Go binary at /opt/clawcode/bin/clawcode-mcp-shim --type X
   *   - "python": (reserved) python3 translator
   *
   * Crash-fallback (LOCKED): same as fleet-wide — no try/catch around
   * the alternate-runtime path. Operator-locked decision is fail-loud.
   */
  shimRuntime: z
    .object({
      search: z.enum(["node", "static", "python"]).optional(),
      image: z.enum(["node", "static", "python"]).optional(),
      browser: z.enum(["node", "static", "python"]).optional(),
      // P5 — per-agent broker rollback override (Stage 0c).
      broker: z.enum(["node", "static"]).optional(),
    })
    .optional(),
  /**
   * Phase 117 Plan 06 — per-agent advisor override.
   *
   * Mirrors the shimRuntime per-agent shape: every field optional so the
   * loader resolvers (`resolveAdvisorBackend` / `resolveAdvisorModel` /
   * `resolveAdvisorMaxUsesPerRequest` / `resolveAdvisorCaching` in
   * `./loader.ts`) can fall through (per-agent → defaults.advisor →
   * hardcoded baseline) without forcing operators to re-specify the full
   * block when overriding one knob.
   *
   * Use case: canary the native SDK backend on ONE agent first —
   *   agents.<name>.advisor.backend: native
   * flips just that agent to the new backend while the rest of the fleet
   * stays on whatever `defaults.advisor.backend` says. Survives agent
   * restart (loader re-resolves on every spawn). Same flip-back pattern
   * is the locked rollback gate from CONTEXT.md `<decisions>.Architecture`.
   *
   * `agentAdvisorOverrideSchema` enforces the same backend enum as
   * `defaults.advisor` — `"portable-fork"` is rejected at parse time.
   */
  advisor: agentAdvisorOverrideSchema.optional(),
  /**
   * Phase 999.100 — per-agent mid-turn steering override. Canary dial:
   * `agents.<name>.steering.autoClassify: true` enables intent
   * classification on ONE agent while the fleet stays on
   * `defaults.steering` (default off). Per-field cascade in the loader,
   * same shape as the Phase 117 advisor cascade.
   */
  steering: agentSteeringOverrideSchema.optional(),
  /**
   * 999.101 — bot-trigger allowlist. The bridge drops all bot-authored
   * channel messages; each entry here lets ONE bot author (matched by
   * username case-insensitively, or by exact `authorId` when set)
   * dispatch an automated turn to this agent, coalesced by a per-author
   * cooldown. NEVER allowlist another agent's bot user — that recreates
   * the agent-loop the bot gate exists to prevent (the cooldown floors
   * the blast radius, but the loop would still burn turns).
   */
  botTriggers: z
    .array(
      z.object({
        author: z.string().min(1),
        authorId: z.string().min(1).optional(),
        cooldownMinutes: z.number().int().min(1).max(1440).default(15),
        enabled: z.boolean().default(true),
      }),
    )
    .optional(),
  /**
   * Phase 999.63 Plan 04 — per-agent financial-verification enforcement
   * override (CONTEXT.md D6). `enforced: true` opts a non-fin agent into
   * the Phase 999.63 gate; `enforced: false` opts a `fin-*` / `acme-*`
   * agent out. Omitted → the resolver (`isVerificationEnforced`)
   * uses the name-prefix default. RELOADABLE — see the schema doc-comment
   * on `verificationConfigSchema`.
   */
  verification: verificationConfigSchema.optional(),
  /**
   * DEPRECATED ALIAS for `verification` (renamed 2026-08-26 — the gate is
   * not finance-specific any more; the finance vocabulary is one topic
   * profile among several).
   *
   * This alias is NOT optional politeness. `agentSchema` is non-strict:
   * an unrecognised key is SILENTLY DROPPED, not rejected. Without this
   * field a prod yaml still saying `financialVerification:` would lose
   * its whole block with no error — `streamStatus`/`verifiedBadge` would
   * fall to false and the 999.63b shadow gate would stop evaluating
   * mid-window, invisibly. That is the exact failure class this gate
   * exists to prevent, so the alias ships BEFORE the yaml is migrated
   * and is removed only after prod is confirmed on the new key.
   *
   * Resolution order in loader.ts: `verification ?? financialVerification`.
   */
  financialVerification: verificationConfigSchema.optional(),
  /**
   * Phase 135 Plan 01 — per-agent voice channel config.
   *
   * Optional block. Missing block = the agent has no voice — `/vc join`
   * for this agent will fail at the Plan 02 lookup site (`getVoiceCfg`
   * returns null). Mirrors the Phase 117 advisor optionality pattern.
   *
   * `voiceConfigSchema` enforces the required-fields trio
   * (deepgramKey, elevenLabsKey, voiceId) so any present block is
   * fully usable by Plan 02's STT/TTS adapters without further defaulting.
   *
   * NON_RELOADABLE_FIELDS contains `voice` — runtime changes to this
   * block require an agent restart (joining/leaving voice has side
   * effects that don't compose with hot-swap).
   */
  voice: voiceConfigSchema.optional(),
  /**
   * Phase 136 — per-agent LlmRuntime backend override.
   *
   * Mirrors the Phase 117 `advisor` shape: every field optional so an
   * operator can flip just `backend` for canary rollout. Phase 136 ships
   * with the enum locked to a single value (`"anthropic-agent-sdk"`); a
   * per-agent block is functionally equivalent to omission until Phase 137
   * widens the enum.
   *
   * Survives agent restart (loader re-resolves on every spawn). Locked
   * by NON_RELOADABLE_FIELDS — runtime backend selection is a session-
   * boot baseOptions field, not a per-turn knob. Same architectural
   * pattern as Phase 117 `advisor.backend` and Phase 999.54 `alwaysLoad`.
   */
  llmRuntime: agentLlmRuntimeOverrideSchema.optional(),
  /**
   * Phase 137 Plan 04 — per-agent providers credentials override.
   * Cascade per loader resolver: agents[].providers.openai.apiKeyPath
   * wins over defaults.providers.openai.apiKeyPath when both set.
   * RELOADABLE — see types.ts RELOADABLE_FIELDS. Schema mirrors
   * `providersConfigSchema` exactly; the override is a thin pass-through.
   */
  providers: providersConfigSchema.optional(),
  /**
   * Phase 124 Plan 02 D-06 — per-agent override for the auto-compaction
   * trigger ratio (0..1). When omitted, loader's `resolveAutoCompactAt`
   * falls through to `defaults['auto-compact-at']` (zod default 0.7).
   * Plan 125 consumes the resolved value to gate auto-compaction; Phase
   * 124 only ships the schema + loader resolver so `clawcode reload`
   * picks up edits without a daemon restart.
   */
  "auto-compact-at": z.number().min(0).max(1).optional(),
  /**
   * Phase 125 Plan 02 — per-agent count of trailing conversation turns
   * preserved VERBATIM during auto-compaction. Resolves to defaults
   * (`preserveLastTurns`) when omitted; final fallback is 10. Range
   * 1..100. Plan 02's `partitionForVerbatim` gate ALWAYS preserves these
   * turns regardless of tier 4 drop rules.
   */
  preserveLastTurns: z.number().int().min(1).max(100).optional(),
  /**
   * Phase 125 Plan 02 (SC-8) — per-agent verbatim regex patterns. Any
   * turn whose `content` matches ANY pattern bypasses tier 4 drop. The
   * loader compiles each entry once at resolve time and rejects invalid
   * regex at config-load. Default `[]` (back-compat — existing agents
   * see no behavior change). Acme agents will populate the
   * Acme-specific patterns (`\\bAUM\\b`, `\\$[0-9]`) via YAML.
   */
  preserveVerbatimPatterns: z.array(z.string().min(1)).optional(),
  /**
   * Phase 999.25 — wake-order priority for boot-time auto-start.
   *
   * Lower numbers boot first. Agents without `wakeOrder` boot LAST in YAML
   * order (stable sort). Ties (same wakeOrder) preserve YAML order.
   *
   * Example:
   *   - admin-clawdy:    wakeOrder: 1   → boots first
   *   - fin-client: wakeOrder: 2   → boots second
   *   - research:        wakeOrder: 3   → boots third
   *   - fin-research:    wakeOrder: 3   → boots fourth (tie → YAML order)
   *   - everyone else:   no wakeOrder   → boots after, in YAML order
   *
   * Boot is sequential (startAll iterates with `for...await`), so wakeOrder
   * only changes the ORDER, not the total time. Use case: ensure operator-
   * critical agents (Admin Clawdy, Client A's fin-client) come up before
   * peripheral agents during cold restarts.
   *
   * Reload classification: next-boot only — startAll has run by reload time.
   */
  wakeOrder: z.number().int().optional(),
  // Phase 94 TOOL-10 / D-10 — per-agent override of fleet directives.
  // Additive + optional: v2.5 migrated configs parse unchanged (loader
  // resolver fills from DEFAULT_SYSTEM_PROMPT_DIRECTIVES via
  // defaults.systemPromptDirectives). Per-key partial merge — setting
  // `agents.foo.systemPromptDirectives["file-sharing"].enabled = false`
  // disables that directive for foo only; cross-agent-routing still
  // inherits the default. Reloadable (next-turn boundary).
  systemPromptDirectives: z
    .record(z.string(), systemPromptDirectiveOverrideSchema)
    .optional(),
  // Phase 999.13 DELEG-01 — per-agent specialty → target-agent map.
  // Free-form keys (no enum lock-in): operators add `coding`, `legal`,
  // etc. via yaml without code changes. configSchema.superRefine
  // (below) rejects unknown target names at config load.
  // Optional + additive — agents without this field parse byte-
  // identically to v2.6 (back-compat invariant).
  delegates: z.record(z.string().min(1), z.string().min(1)).optional(),
  // Tenant/owner tag for cross-agent isolation (2026-06-27). Agents with
  // different non-undefined owners cannot reach each other via the daemon's
  // cross-agent IPC vectors (admin agents exempt). Optional + additive —
  // untagged agents parse unchanged. See agent-owner-isolation.ts.
  owner: z.string().min(1).optional(),
  /**
   * claude.ai account connectors (Drive, Docs, Gmail… — `mcp__claude_ai_*`).
   * Opt-in per agent AND only honoured when the agent's `owner` is listed in
   * `defaults.claudeAiConnectors.allowedOwners` and the agent is not `admin`
   * (admin agents accept cross-owner requests). Everything else runs with
   * `ENABLE_CLAUDEAI_MCP_SERVERS=false`. NON_RELOADABLE — spawn env.
   */
  claudeAiConnectors: z.boolean().optional(),
  /**
   * Phase 999.123 — run the reserved `verify-figures` fact-check step before
   * the final report (figure/source ledger, `[unverified]` flags, Verification
   * appendix). Overrides `defaults.workflow.output.verifyFigures`.
   */
  workflowVerifyFigures: z.boolean().optional(),
  /**
   * Phase 999.128 — named workflow templates this agent can launch with
   * `start_workflow({ template, params })`. Per-agent entries override
   * `defaults.workflow.templates` entries with the same name.
   */
  workflowTemplates: z.array(workflowTemplateSchema).optional(),
  // Phase 95 DREAM-01..03 — per-agent autonomous reflection cycle.
  // Additive + optional: v2.5/v2.6 migrated configs parse unchanged when
  // omitted; loader resolver fills from defaults.dream. Per-agent override
  // wins for any field set; partial overrides inherit unset fields from
  // defaults. 9th application of the Phase 83/86/89/90/94 additive-
  // optional schema blueprint.
  dream: dreamConfigSchema.optional(),
  // Per-agent VOICE profile for the OpenAI endpoint (opt-in, default off).
  // See openaiVoiceConfigSchema. Absent → stateless + 15s, byte-identical.
  openaiVoice: openaiVoiceConfigSchema.optional(),
  // Phase 142 — per-agent agent-optimizer config (measure→propose→keep loop).
  // Additive + optional; resolver falls back to defaults.optimizer. Same
  // additive-optional blueprint as `dream`.
  optimizer: optimizerConfigSchema.optional(),
  // Phase 96 D-05 — 10th additive-optional schema application; per-agent
  // operator-shared filesystem path candidates verified by runFsProbe at
  // boot + heartbeat tick. Schema preserves literal `{agent}` token; loader
  // resolveFileAccess expands it at call time. Each entry must be a non-
  // empty string; empty array allowed for explicit no-access fleet config.
  // Resolved set merges defaults.fileAccess (default-bearing) + per-agent
  // override (additive). v2.5 migrated configs parse unchanged. Reload
  // classification deferred to Plan 96-07 (config-watcher hot-reload).
  fileAccess: z.array(z.string().min(1)).optional(),
  // Phase 96 D-09 — 11th additive-optional schema application; per-agent
  // outputDir template string. Tokens ({date}/{agent}/{channel_name}/
  // {client_slug}) preserved literally; runtime resolveOutputDir expands
  // them with fresh ctx. Per-agent override beats defaults.outputDir.
  // v2.5/v2.6 migrated configs parse unchanged when omitted. Path traversal
  // is blocked at runtime (resolveOutputDir refuses leading `/` and `..`).
  outputDir: z.string().optional(),
  // Phase 100 GSD-02 / RESEARCH.md Pitfall 3 — 12th application of the
  // additive-optional schema blueprint (Phases 83/86/89/90/94/95/96).
  // Per-agent SDK settingSources. Default ["project"] applied at the loader
  // layer (resolveAgentConfig) — this schema field stays optional so v2.5/
  // v2.6 migrated configs parse unchanged. .min(1) rejects [] explicitly:
  // an empty array would silently disable all filesystem settings (no skills,
  // no CLAUDE.md, no commands) per SDK docs — Pitfall 3 in 100-RESEARCH.md.
  // Admin Clawdy sets ["project","user"] in clawcode.yaml so the SDK loads
  // ~/.claude/commands/gsd/*.md (the GSD slash command files symlinked by
  // Plan 06). Production agents (fin-client, etc.) keep ["project"] —
  // omitting the field falls back to the loader default. Duplicates are
  // permitted (zod doesn't dedup); the SDK treats redundant entries idempotently.
  settingSources: z.array(z.enum(["project", "user", "local"])).min(1).optional(),
  // Phase 100 GSD-04 — per-agent gsd block. Currently only carries projectDir;
  // future fields (commitsAllowed, autoThreadKey, etc.) land here. Optional —
  // omission means "use agent.workspace as cwd" per the loader resolver in
  // Plan 02 (the consumer of this field). Per CONTEXT.md decision: only
  // Admin Clawdy sets gsd.projectDir; production agents do NOT.
  gsd: z.object({
    projectDir: z.string().min(1).optional(),
  }).optional(),
  skills: z.array(z.string()).default([]),
  // dashboard-rework — native Claude Code plugins enabled for this agent, as
  // `<plugin>@<marketplace>` refs (e.g. "discord@claude-plugins-official").
  // Attached at spawn: v3 via a `plugin:<ref>` channel tag + inlined plugin MCP
  // servers; v2/SDK via the plugin's resolved MCP servers. NON-RELOADABLE
  // (captured into the spawn argv / SDK options at session start).
  // `.optional()` (not `.default([])`) keeps `plugins` optional in the schema
  // OUTPUT type so existing resolved-config literals/fixtures compile unchanged;
  // the loader normalizes via `agent.plugins ?? []`.
  plugins: z.array(z.string()).optional(),
  soul: z.string().optional(),
  identity: z.string().optional(),
  // Phase 78 CONF-01 — file-pointer SOUL/IDENTITY. Mutually exclusive with
  // inline `soul` / `identity` (enforced at configSchema level via
  // superRefine below). Raw string stored here — expansion via
  // expandHome() happens in loader.ts in the same plan. Absolute or
  // `~/...` paths. When set, the daemon reads the file lazily at session
  // boot (see src/manager/session-config.ts precedence chain).
  soulFile: z.string().min(1).optional(),
  identityFile: z.string().min(1).optional(),
  memory: memorySchema.optional(),
  // Phase 90 Plan 07 WIRE-02 — per-agent heartbeat config.
  //
  // Legacy shape: `heartbeat: true|false` — a simple enable/disable flag
  // (behavior pre-Phase-90; `false` disables the heartbeat for this agent,
  // `true` defers to `defaults.heartbeat`).
  //
  // Extended shape: `heartbeat: { every?, model?, prompt? }` — carries an
  // OpenClaw-style per-agent heartbeat prompt + cadence (e.g. the 50-minute
  // context-zone monitor used by fin-client). All fields optional so
  // a partial override is fine; resolver falls back to `defaults.heartbeat`
  // for unset fields.
  //
  // Accepted as a `z.union` so v2.1 migrated configs (all use boolean)
  // parse unchanged.
  heartbeat: z
    .union([
      z.boolean(),
      z.object({
        enabled: z.boolean().optional(),
        every: z.string().min(1).optional(),
        model: modelSchema.optional(),
        prompt: z.string().optional(),
      }),
    ])
    .default(true),
  schedules: z.array(scheduleEntrySchema).default([]),
  admin: z.boolean().default(false),
  sandbox: sandboxConfigSchema.optional(),
  subagentModel: modelSchema.optional(),
  /**
   * Phase 999.162 WS-1 — per-agent Claude Code tool search (`ENABLE_TOOL_SEARCH`).
   * Measured 2026-09-23: tool search was ON fleet-wide yet deferred nothing — 61 tools,
   * 49 of them `mcp__*`, ~80 KB of schemas in every ~260 KB request — because the
   * auto threshold never trips under a 1M-token window. `"true"` forces deferral of
   * every MCP tool behind `ToolSearch`; `"auto:N"` defers once definitions reach N% of
   * the context window; `"false"` loads everything. Omitted = the CLI's own default.
   * Deliberately a narrow knob, NOT a generic env passthrough: an agent-level env map
   * would let config override the spawn-env credential strip (`ANTHROPIC_API_KEY`).
   * NON-RELOADABLE — the value is captured into the spawn env; `clawcode restart <agent>`.
   */
  toolSearch: z.union([z.enum(["true", "false", "auto"]), z.string().regex(/^auto:(100|[1-9]?\d)$/)]).optional(),
  /**
   * Phase 999.161 — fast lane. A short standalone message that needs no tools is
   * answered in seconds on the haiku-direct bridge (soul + identity + hot
   * memories + recent turns) with a `⚡` footer; anything unsure or anything the
   * quick answer cannot handle falls through to the ordinary session turn. See
   * src/manager/fast-lane.ts and fast-lane-routing.ts.
   *
   * Phase 999.164 — ON for every agent by default (Operator, 2026-09-23); the runtime
   * `/clawcode-quick` toggle (fast-lane-state.json) layers over this per agent.
   */
  fastLane: fastLaneSchema.optional(),
  /** Phase 999.171 — per-agent UX toggles (see uxFeaturesSchema). No `.default({})` (zod trap). */
  uxFeatures: uxFeaturesSchema.optional(),
  /** Phase 999.173 — research-subagent knobs (see researchSchema). */
  research: researchSchema.optional(),
  // Phase 100 follow-up — operator-curated default effort raised low → high
  // (2026-04-28). Agents without an explicit effort field now ship at high
  // by default. Agents with explicit effort: low keep their override.
  effort: effortSchema.default("high"),
  /**
   * Quick 260715-j1j (D5) — per-agent opt-OUT of the fleet-wide native
   * Workflow tool block. When true, the loader resolver filters EXACTLY the
   * string "Workflow" out of this agent's resolved `disallowedTools` (single
   * -name subtraction — never a general per-agent disallowedTools surface,
   * never weakens other entries) and the anti-Workflow steer flips to the
   * bounded permitted variant. Also a hard prerequisite for the `ultracode`
   * effort level (D6 runtime gate + D7 load validation).
   *
   * **NON-RELOADABLE** — like `defaults.disallowedTools` (see its doc
   * comment below), the deny-list this flag subtracts from is BAKED INTO
   * the SDK session at create/resume (session-adapter.ts). A YAML flip
   * takes effect for a RUNNING PRIMARY agent only on a daemon RESTART.
   * Default false: the fleet keeps the Workflow block byte-identically.
   *
   * `.default(false).optional()` mirrors the `disallowedTools` shape below:
   * the field is `boolean | undefined` at the type level so existing
   * AgentConfig test factories compile without an explicit entry; every
   * consumer gates on `=== true`, so an omitted key (parsed `undefined`)
   * behaves exactly as false (fail-closed).
   */
  nativeWorkflow: z.boolean().default(false).optional(),
  /**
   * WS-0 (quick 260716-u5h) — per-agent ADDITIVE deny-list. The loader UNIONs
   * these entries onto the fleet floor (after the nativeWorkflow single-name
   * Workflow subtraction above), deduped, floor order preserved, agent
   * additions appended in YAML order.
   *
   * ADDITIVE-ONLY by design: a per-agent entry can only ADD a blocked tool,
   * never remove a fleet-blocked one — the sanctioned subtraction surface
   * remains exactly `nativeWorkflow` (see its doc). Corollary: an agent that
   * explicitly lists "Workflow" here wins over its own nativeWorkflow opt-out
   * (do not combine that with `effort: ultracode`, which needs Workflow).
   *
   * Closes the 2026-07-14 RCA finding that per-agent `disallowedTools:` in
   * prod YAML (e.g. Harvey's `[Bash]`) was silently zod-stripped — the config
   * read as if the block were live while the SDK never saw it. Omitted →
   * resolver yields the floor verbatim (fleet byte-stability).
   */
  disallowedTools: z.array(z.string()).optional(),
  // 999.103 WS-1 — per-agent TodoWrite-mirror override (whole-object cascade
  // over defaults.todoMirror).
  todoMirror: todoMirrorSchema.optional(),
  /**
   * 999.105 — per-agent output-style baseline (runtime /clawcode-style
   * overrides take precedence). Cascades over defaults.outputStyle in the
   * loader. RELOADABLE: the dispatcher reads the resolved value per turn.
   */
  outputStyle: outputStyleSchema.optional(),
  slashCommands: z.array(slashCommandEntrySchema).default([]),
  threads: threadsConfigSchema.optional(),
  webhook: webhookConfigSchema.optional(),
  reactions: z.boolean().default(true),
  security: securityConfigSchema.optional(),
  mcpServers: z.array(z.union([mcpServerSchema, z.string()])).default([]),
  /**
   * Phase 100 follow-up — per-agent MCP server env overrides. Maps
   * `serverName → envKey → value`. Values matching `op://...` are resolved
   * at agent-start time via the daemon's `op read` shell-out (using the
   * daemon's process-level OP_SERVICE_ACCOUNT_TOKEN, which is the clawdbot
   * full-fleet service account). The resolved values replace whatever the
   * shared mcpServers[].env block provides, then get injected into the
   * spawned MCP subprocess env.
   *
   * Use case: vault-scope distribution. The daemon process holds the
   * clawdbot full-fleet token; this lets acme agents get a Acme-
   * vault-scoped token (whose source-of-truth is itself a credential
   * stored INSIDE the clawdbot vault) WITHOUT the daemon's clawdbot token
   * ever leaving the daemon process.
   *
   * Example:
   *   mcpEnvOverrides:
   *     1password:
   *       OP_SERVICE_ACCOUNT_TOKEN: "op://example-vault-21/Acme Service Account/credential"
   *
   * Schema: server name + env key + env value all required to be non-empty
   * strings. Empty server name / key / value rejected at parse — those
   * shapes either silently no-op (empty server name doesn't match any
   * configured MCP) or break the env (zero-length token).
   *
   * Optional + missing field parses fine (back-compat with the existing
   * 15-agent fleet — all currently inherit the daemon's clawdbot token).
   */
  mcpEnvOverrides: z
    .record(
      z.string().min(1), // server name (must match an mcpServers entry)
      z.record(
        z.string().min(1), // env key
        z.string().min(1), // env value (op:// URI or literal)
      ),
    )
    .optional(),
  acceptsTasks: z                      // Phase 59 HAND-04
    .record(z.string().min(1), z.array(z.string().min(1)))
    .optional(),
  contextBudgets: contextBudgetsSchema.optional(),
  escalationBudget: z.object({
    daily: z.object({
      sonnet: z.number().int().positive().optional(),
      opus: z.number().int().positive().optional(),
    }).optional(),
    weekly: z.object({
      sonnet: z.number().int().positive().optional(),
      opus: z.number().int().positive().optional(),
    }).optional(),
  }).optional(),
  perf: z
    .object({
      traceRetentionDays: z.number().int().positive().optional(),
      taskRetentionDays: z.number().int().positive().default(7),
      slos: z.array(sloOverrideSchema).optional(),
      memoryAssemblyBudgets: memoryAssemblyBudgetsSchema.optional(),
      lazySkills: lazySkillsSchema.optional(),
      resumeSummaryBudget: resumeSummaryBudgetSchema.optional(),
      streaming: streamingConfigSchema.optional(),
      tools: toolsConfigSchema.optional(),
    })
    .optional(),
  // Phase 113 — per-agent Haiku vision pre-pass for image attachments.
  // When enabled, image attachments are resized and analysed by Haiku before
  // the main agent turn, injecting <screenshot-analysis> into the message.
  // Default false so the fleet opts in per-agent. Auth via OAuth token
  // (haiku-direct.ts), never ANTHROPIC_API_KEY.
  //
  // Phase 999.154 — `mode` (default "inline"): images go to the agent's OWN
  // model as native image blocks, budgeted (`inline`) with numbered contact
  // sheets for overflow; "prepass" keeps the Haiku pre-pass (rollback);
  // "off" sends path hints only. `burst` gathers a multi-message upload
  // (Discord caps 10 attachments/message) into one turn. `preserveImage` is a
  // deprecated no-op kept so existing yaml parses.
  vision: z
    .object({
      enabled: z.boolean().default(false),
      preserveImage: z.boolean().default(false),
      mode: z.enum(["inline", "prepass", "off"]).optional(),
      inline: z
        .object({
          fullResImages: z.number().int().min(0).max(20).optional(),
          maxImageTokens: z.number().int().min(1000).max(200_000).optional(),
          maxImages: z.number().int().min(1).max(100).optional(),
          screenshotSidePx: z.number().int().min(256).max(2000).optional(),
          photoSidePx: z.number().int().min(256).max(2000).optional(),
          contactSheet: z
            .object({
              grid: z.number().int().min(2).max(4).optional(),
              tilePx: z.number().int().min(256).max(768).optional(),
            })
            .optional(),
        })
        .optional(),
      burst: z
        .object({
          quietMs: z.number().int().min(0).max(10_000).optional(),
          maxWaitMs: z.number().int().min(0).max(30_000).optional(),
        })
        .optional(),
    })
    .optional(),
  // Phase 115 sub-scope 14 — operator-toggle for the diagnostic baseopts
  // dump. Default false: zero noise on the fleet. Replaces the temporary
  // hardcoded fin-client + Admin Clawdy allowlist deployed during the
  // 2026-05-07 incident response. When true, the daemon writes a per-agent
  // baseopts dump to ~/.clawcode/agents/<agent>/diagnostics/baseopts-<flow>-
  // <ts>.json on every createSession/resumeSession (secrets redacted via
  // session-adapter.ts:redactSecrets). Optional + additive — every existing
  // agent yaml parses unchanged with this field omitted.
  debug: z.object({
    // Phase 115 sub-scope 14 — operator-toggle for dumpBaseOptionsOnSpawn.
    // Default false. Replaces the hardcoded fin-client + Admin Clawdy
    // allowlist deployed during the 2026-05-07 incident response. When true,
    // daemon writes per-agent baseopts dump to ~/.clawcode/agents/<agent>/
    // diagnostics/baseopts-<flow>-<ts>.json on every createSession /
    // resumeSession (secrets redacted via session-adapter.ts:redactSecrets).
    dumpBaseOptionsOnSpawn: z.boolean().default(false),
  }).optional(),
});

/**
 * Schema for top-level defaults that agents inherit.
 */
export const defaultsSchema = z.object({
  model: modelSchema.default("haiku"),
  /**
   * claude.ai connector entitlement: the owners whose agents may opt in via
   * `agents.*.claudeAiConnectors: true`. Omitted/empty = nobody (fail-closed).
   * NON_RELOADABLE — spawn env.
   */
  claudeAiConnectors: z
    .object({ allowedOwners: z.array(z.string().min(1)).default([]) })
    .optional(),
  // Phase 100 follow-up — fleet-wide default effort raised low → high.
  effort: effortSchema.default("high"),
  // Phase 86 MODEL-01 — fleet-wide allowlist default. When an agent
  // omits `allowedModels`, the resolver substitutes this array.
  //
  // Phase 999.114 — was ["haiku","sonnet","opus"]. Now DEFAULT_PICKER_MODELS
  // (every catalog alias) so the Discord picker offers every tier and every
  // historical pin. ⚠ This value is MIRRORED by the `defaults` default factory
  // on configSchema below — both must stay in sync, which is exactly why both
  // now spread the same catalog constant instead of re-listing aliases.
  allowedModels: z.array(modelSchema).default(() => [...DEFAULT_PICKER_MODELS] as ConfigModel[]),
  // Phase 89 GREET-07 — fleet-wide default for restart-greeting emission.
  // Default true per D-09 — every agent greets on restart unless opted out.
  greetOnRestart: z.boolean().default(true),
  /**
   * Phase 999.187 — fleet-wide default `owner` for agents that omit it. The
   * owner keys the shared-facts store (999.131): with no owner an agent can
   * neither save nor read owner-scoped facts, so "I prefer brief answers"
   * told to one agent never reaches the others. Opt-in (no default) because
   * `owner` also draws the cross-owner filesystem boundary and the
   * claude.ai connector entitlement; set it once in `defaults:` and every
   * unowned agent joins that tenant.
   */
  owner: z.string().min(1).optional(),
  // Phase 89 GREET-10 — fleet-wide default for the cool-down window (ms).
  // 300_000 ms = 5 minutes per D-14.
  greetCoolDownMs: z.number().int().positive().default(300_000),
  // Phase 90 MEM-01 — Fleet-wide default: true (every agent auto-loads
  // its workspace MEMORY.md unless explicitly opted out). D-17 + D-18.
  memoryAutoLoad: z.boolean().default(true),
  // Phase 90 MEM-03 — fleet-wide hybrid-RRF retrieval top-K (default 5
  // per D-RETRIEVAL). Reloadable — next turn picks up the new value via
  // the getMemoryRetrieverForAgent closure re-read.
  memoryRetrievalTopK: z.number().int().positive().max(50).default(5),
  /**
   * Phase 999.124 — fleet default for the memory-recall reply footer.
   * Optional (no zod default) so the inferred defaults type stays
   * fixture-compatible; the loader treats absent as ON.
   */
  memoryRecallFooter: z.boolean().optional(),
  /** Phase 999.133 — fleet default for the recall display (absent = button). */
  memoryRecallDisplay: z.enum(["button", "footer"]).optional(),
  /**
   * Phase 999.127 — fleet settings for the weekly memory digest. Absent =
   * enabled, Mondays 09:00 America/Los_Angeles, 8 items.
   */
  memoryDigest: z
    .object({
      enabled: z.boolean().optional(),
      cron: z.string().min(1).optional(),
      timezone: z.string().min(1).optional(),
      maxItems: z.number().int().min(1).max(10).optional(),
    })
    .optional(),
  /**
   * Phase 999.130 — weekly fleet report card posted to the admin channel.
   * Absent = Mondays 09:10 America/Los_Angeles.
   */
  reportCard: z
    .object({
      cron: z.string().min(1).optional(),
      timezone: z.string().min(1).optional(),
    })
    .optional(),
  // Phase 115 sub-scope 3 — fleet-wide token budget for the per-turn
  // <memory-context> block. Down from the pre-115 hardcoded 2000 — the zod
  // knob existed in defaultsSchema since Phase 90 MEM-03 but was never
  // forwarded to retrieveMemoryChunks (Pain Point #1, codebase-memory-
  // retrieval.md). Phase 115 Plan 01 wires it through and tightens the
  // default to leave margin for sub-scope 1's tier-1 cap. 1500 ≈ ~6000
  // chars; range 500-8000 (validated). Reloadable — next turn picks up
  // via the getMemoryRetrieverForAgent closure re-read.
  memoryRetrievalTokenBudget: z.number().int().min(500).max(8000).default(1500),
  // Phase 115 sub-scope 4 — fleet-wide tag-exclusion list applied at the
  // hybrid-RRF memory retrieval BEFORE the chunks-side fan-out is fused
  // with the memories-side. The locked default removes pollution-feedback
  // memories that previously leaked into the <memory-context> block as
  // giant blobs (research codebase-memory-retrieval.md Pain Points #3 +
  // #15). Per-agent override available via agentSchema. Empty array
  // disables filtering entirely; a populated array fully replaces the
  // defaults (does NOT merge).
  memoryRetrievalExcludeTags: z
    .array(z.string())
    .default(() => ["session-summary", "mid-session", "raw-fallback"]),
  // Phase 115 sub-scope 2 — fleet-wide default for the SDK
  // systemPrompt.excludeDynamicSections flag. When true, per-machine
  // dynamic sections (cwd, auto-memory paths, git status) are stripped
  // from the cached system prompt and re-injected as the first user
  // message — improves cross-agent prompt-cache reuse. Default true per
  // CONTEXT.md sub-scope 2 lock; set false to revert to pre-115 behavior.
  // Reload classification: NEXT-SESSION only.
  excludeDynamicSections: z.boolean().default(true),
  // Phase 115 sub-scope 5 (Plan 04) — fleet-wide cache-breakpoint placement
  // mode. "static-first" (default): static sections (identity, soul, skills,
  // tools, fs-capability, delegates) land BEFORE the breakpoint marker;
  // dynamic sections (hot memories, graph context) land AFTER. Mirrors
  // Hermes static-then-dynamic placement; the operator-priority goal is
  // recovering prompt-cache hit rate by stabilizing the bytes prior to the
  // marker across most turns. "legacy" — pre-115 interleaved order, no
  // marker emitted — revert path. Reload classification: NEXT-SESSION only.
  cacheBreakpointPlacement: z
    .enum(["static-first", "legacy"])
    .default("static-first"),
  // Phase 90 MEM-02 — fleet-wide scanner on/off. Default true — every
  // agent starts a chokidar watcher on its {workspace}/memory/**/*.md.
  memoryScannerEnabled: z.boolean().default(true),
  // Phase 90 MEM-04 — fleet-wide mid-session flush cadence (D-26). Default
  // 15 minutes. Every active session's MemoryFlushTimer fires this often
  // (skip heuristic bails if no meaningful turns since last flush).
  memoryFlushIntervalMs: z.number().int().positive().default(900_000),
  // Phase 999.6 SNAP-04 — staleness threshold for pre-deploy-snapshot.json (hours).
  // 24h default per CONTEXT.md. Configurable so operators can tune.
  // Default-bearing → existing v2.5/v2.6 configs parse unchanged.
  preDeploySnapshotMaxAgeHours: z
    .number()
    .int()
    .positive()
    .default(24)
    .optional(),
  // Phase 999.176 — fleet Max-account swap (/clawcode-account). Each slot is
  // a saved credential `.credentials.<name>.json` beside the live one; `email`
  // is what a re-login must sign in as (the post-login gate refuses anything
  // else) and `opItem` is an optional 1Password hint for the Mac sign-in.
  // `macAgent` overrides which agent drives the MacBook (default: the agent
  // flagged `admin: true`). Read lazily per use, so reloadable.
  accountSwap: z
    .object({
      slots: z
        .array(
          z.object({
            name: z.string().regex(/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/),
            email: z.string().email(),
            opItem: z.string().min(1).max(200).optional(),
          }),
        )
        .max(5)
        .default([]),
      macAgent: z.string().min(1).optional(),
    })
    .optional(),
  // Phase 999.12 HB-01 — per-check inbox heartbeat timeout in milliseconds.
  // Default 60_000 (60s) — comfortably exceeds typical Sonnet/Opus tool-using
  // cross-agent turn duration (30-90s) so the heartbeat inbox check no longer
  // false-positive-criticals during normal IPC traffic. Set to undefined or
  // omit to fall back to the fleet-wide `heartbeat.checkTimeoutSeconds`.
  // Default-bearing → existing v2.x configs parse unchanged. Same additive-
  // optional shape as preDeploySnapshotMaxAgeHours above.
  heartbeatInboxTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(60_000)
    .optional(),
  // Phase 90 MEM-05 — fleet-wide default reaction emoji for cue detection
  // (D-32). Standard ✅ — operators can override per-agent or fleet-wide.
  memoryCueEmoji: z.string().min(1).max(8).default("✅"),
  // Phase 999.43 D-09 — fleet-wide default for the per-agent
  // autoIngestAttachments flag. DEFAULT FALSE per D-09: existing
  // (pre-999.43) configs see no behavior change. Operators opt agents
  // in individually OR flip this to true to opt the whole fleet in.
  // Reloadable — see RELOADABLE_FIELDS in types.ts.
  autoIngestAttachments: z.boolean().default(false),
  // Phase 999.43 D-01 Axis 1 — fleet-wide default ingestion priority.
  // Multipliers per D-01: high=1.5, medium=1.0, low=0.7 (applied at
  // retrieval time per D-02 score formula). Default "medium" → 1.0×
  // (no-op) so back-compat is preserved when an operator flips
  // autoIngestAttachments true but hasn't tuned per-agent priorities yet.
  ingestionPriority: z.enum(["low", "medium", "high"]).default("medium"),
  // Phase 132 D-08 — fleet-wide default for the per-agent
  // autonomousSkillDrafting flag. DEFAULT FALSE per D-08: existing
  // (pre-132) configs see no behavior change. Operator opts agents in
  // individually (Admin Clawdy first per the 2-week trial cohort) OR
  // flips this to true to enable fleet-wide once calibrated.
  // Reloadable — see RELOADABLE_FIELDS in types.ts.
  autonomousSkillDrafting: z.boolean().default(false),
  // Phase 132 D-03 — fleet-wide default eligibility thresholds for the
  // out-of-band skill distiller. Literal defaults per CONTEXT.md D-03,
  // with the tool-call count amended by Phase 999.42 capability B:
  //   - minToolCalls: 5 (Phase 999.42 CONTEXT D4 — lowered 6→5 for
  //     Hermes parity; Hermes auto-creates skills at 5+ tool calls)
  //   - minDurationMs: 180_000 (3 minutes wall-clock) — UNCHANGED from D-03
  //   - outcomeFilter: ["success"] — UNCHANGED from D-03
  // Per-agent overrides under `agents.*.skillDistiller` merge into these
  // (Plan 02 resolver). `distillerModel` (D-02) is operator-only — no
  // fleet-wide default; per-agent setting is the only way to escalate
  // off Haiku (Plan 02 reads it via the resolver).
  skillDistiller: z
    .object({
      minToolCalls: z.number().int().positive().default(5),
      // D-03 literal: 180000 ms (3 min). Spelled WITHOUT numeric separator
      // so the acceptance_criteria grep `default(180000)` matches textually.
      minDurationMs: z.number().int().positive().default(180000),
      outcomeFilter: z
        .array(z.enum(["success", "partial", "failed"]))
        .nonempty()
        .default(["success"]),
      // Phase 999.42 CONTEXT D7 — fleet-wide default for the patch-suggest
      // path. DEFAULT FALSE: existing configs see zero behavior change.
      // Operator opts an agent in (Admin Clawdy first) via clawcode.yaml.
      suggestPatches: z.boolean().default(false),
    })
    // Outer .default mirrors the inner .default(...) literals — zod 4
    // does NOT auto-cascade inner defaults from an outer .default({}),
    // so we spell the fleet-wide defaults verbatim here. The inner
    // `.default(5)` / `.default(180_000)` / `.default(["success"])`
    // remain grep-anchors for the acceptance_criteria check AND fire
    // when an operator partially specifies the block (e.g. only
    // `skillDistiller: { minToolCalls: 10 }` — minDurationMs and
    // outcomeFilter fall through to the inner defaults).
    // Phase 999.42 capability B (CONTEXT D4) — minToolCalls lowered
    // 6→5 for Hermes parity; minDurationMs + outcomeFilter unchanged
    // from Phase 132 D-03. Phase 999.42 capability C (CONTEXT D7) —
    // suggestPatches added, default false (mirrors the inner .default).
    .default({
      minToolCalls: 5,
      minDurationMs: 180_000,
      outcomeFilter: ["success"],
      suggestPatches: false,
    }),
  // Phase 100 follow-up — fleet-wide default for the per-agent autoStart
  // flag. Default true preserves existing behavior (every configured agent
  // boots on daemon start-all). Operators can flip the polarity to false
  // here and then opt-in only the agents they want live by setting
  // `autoStart: true` on those entries — useful when only a small subset of
  // a large configured fleet is in active rotation.
  autoStart: z.boolean().default(true),
  // Phase 94 TOOL-10 / D-10 — fleet-wide default system-prompt directives.
  //
  // Default-bearing: when omitted from clawcode.yaml, the loader resolves
  // to DEFAULT_SYSTEM_PROMPT_DIRECTIVES (D-09 file-sharing + D-07 cross-
  // agent-routing). v2.5 migrated configs parse unchanged (REG-V25-BACKCOMPAT
  // — additive-optional, 8th application of the Phase 83/86/89/90/92
  // schema blueprint).
  //
  // Reloadable — next agent prompt assembly picks up edits without daemon
  // restart (RELOADABLE_FIELDS in src/config/types.ts).
  systemPromptDirectives: z
    .record(z.string(), systemPromptDirectiveSchema)
    .default(() => ({ ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES })),
  // Phase 95 DREAM-01..03 — fleet-wide default dream cycle config.
  // Default-bearing via dreamConfigSchema's own field defaults
  // (enabled:false / idleMinutes:30 / model:haiku). v2.5/v2.6 migrated
  // configs parse unchanged when omitted. Reloadable: a YAML edit takes
  // effect on the NEXT cron tick / NEXT dream-pass invocation; current
  // in-flight dream passes complete at the previous setting.
  dream: dreamConfigSchema.default(() => ({
    enabled: false,
    idleMinutes: 30,
    model: "haiku" as const,
  })),
  // Phase 142 — fleet-wide default agent-optimizer config. OPTIONAL (mirrors
  // defaults.voice / defaults.advisor): omitted ⇒ undefined ⇒ optimizer off
  // fleet-wide. The resolver does `agent.optimizer ?? defaults.optimizer`, so an
  // agent inherits this only when an operator sets it; when present, the block's
  // own field defaults fill (enabled:false / model:opus / maxActionsPerRun:3 /
  // samplesPerTask:3 / minImprovementMargin:0.1). v2.x configs parse unchanged
  // when omitted. Reloadable: takes effect on the NEXT optimization run.
  optimizer: optimizerConfigSchema.optional(),
  // Phase 96 D-05 — 10th additive-optional schema application; fleet-wide
  // default filesystem path candidates. The `{agent}` literal token is
  // preserved here verbatim (NOT expanded at parse time) — loader
  // resolveFileAccess(agentName, ...) substitutes the actual agent name
  // at call time. v2.5/v2.6 migrated configs parse unchanged when omitted.
  // Reload classification deferred to Plan 96-07 (config-watcher hot-reload).
  fileAccess: z
    .array(z.string().min(1))
    .default(() => [...DEFAULT_FILE_ACCESS]),
  // Phase 96 D-09 — 11th additive-optional schema application; fleet-wide
  // default outputDir template. Default 'outputs/{date}/' lands generated
  // files under a dated subdirectory of the agent workspace root. Tokens
  // preserved literally; runtime expansion via resolveOutputDir at write
  // time keeps {date} fresh per call (loader-time expansion would freeze
  // the date at config-load time — wrong on the second day).
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  // Phase 999.13 TZ-02 — operator-local TZ for agent-visible timestamps.
  // IANA name (e.g. "America/Los_Angeles"). When unset, the runtime helper
  // resolveAgentTimezone() falls back to process.env.TZ → host TZ via
  // Intl.DateTimeFormat resolution (captured once at module load).
  // Pre-validation here catches typos like "Pacific/LosAngeles" at config
  // load (Q3=YES) — fail-fast vs. discovering the bad TZ at first prompt
  // assembly (where the helper would silently fall back to UTC).
  // Internal storage / DB / structured event keys stay UTC ISO; this knob
  // only affects agent-visible *rendering* at the prompt-emission boundary.
  timezone: z
    .string()
    .optional()
    .refine(
      (tz) => {
        if (tz === undefined) return true;
        try {
          new Intl.DateTimeFormat(undefined, { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      },
      {
        message:
          "invalid IANA timezone name (e.g. use 'America/Los_Angeles' not 'Pacific/LosAngeles')",
      },
    ),
  skills: z.array(z.string()).default([]),
  basePath: z.string().default("~/.clawcode/agents"),
  skillsPath: z.string().default("~/.clawcode/skills"),
  // Phase 88 MKT-02 — optional list of legacy skill source roots (typically
  // ~/.openclaw/skills) unioned with the local skillsPath into the /clawcode-
  // skills-browse marketplace catalog. Each entry names a filesystem path
  // (expanded via expandHome at resolution time) and an optional human-
  // readable label shown in the Discord picker.
  // Additive + optional: v2.1/v2.2 migrated configs parse unchanged when
  // omitted; Plan 02 resolver emits a concrete [] for downstream catalog
  // loaders. `path.min(1)` rejects empty strings at parse time.
  // Phase 90 Plan 04 HUB-01 — marketplace sources now accepts a union of
  // (legacy path-based) and (ClawHub registry) entries. The legacy branch
  // matches the pre-Phase-90 shape byte-for-byte so v2.1/v2.2 migrated
  // configs parse unchanged (regression pin: clawhub-schema.test.ts
  // HUB-SCH-2a). The ClawHub branch carries a full HTTPS baseUrl,
  // optional authToken (op://... ref or literal), and optional per-source
  // cacheTtlMs override. When cacheTtlMs is absent, the daemon-wide
  // `clawhubCacheTtlMs` default below applies.
  marketplaceSources: z
    .array(
      z.union([
        // Legacy / v2.2 path-based entry — read-only filesystem source
        // (typically ~/.openclaw/skills). Expanded via expandHome in
        // loader.ts.
        z.object({
          path: z.string().min(1),
          label: z.string().optional(),
        }),
        // Phase 90 HUB-01 — ClawHub registry source. baseUrl points at the
        // root (e.g. https://clawhub.ai); the HTTP client appends
        // /api/v1/skills?... paths. authToken can be literal or op://example-vault-29;
        // Plan 90-06 adds the interactive GitHub-OAuth flow that populates
        // it. cacheTtlMs overrides the fleet-wide default for this one
        // source (D-05).
        z.object({
          kind: z.literal("clawhub"),
          baseUrl: z.string().url(),
          authToken: z.string().min(1).optional(),
          cacheTtlMs: z.number().int().positive().optional(),
        }),
      ]),
    )
    .optional(),
  // Phase 90 Plan 04 HUB-01 — ClawHub registry base URL used when an
  // agent invokes /clawcode-skills-browse without an explicit
  // marketplaceSources[kind:"clawhub"] entry. Default mirrors the D-01
  // decision (confirmed via probe 2026-04-24).
  clawhubBaseUrl: z.string().url().default("https://clawhub.ai"),
  // Phase 90 Plan 04 HUB-08 — In-memory cache TTL for ClawHub registry
  // responses, keyed by {endpoint, query, cursor}. Default 10 min per
  // D-05. Per-source overrides via marketplaceSources[].cacheTtlMs.
  clawhubCacheTtlMs: z.number().int().positive().default(600_000),
  // Phase 999.187 — weeklyThreshold 7 → 4. At 7 a week with ONE missing daily
  // log (any quiet day) was never consolidated, so weekly digests were rare
  // and the "older context" record stayed empty. Four logs is a real week.
  memory: memorySchema.default(() => ({
    compactionThreshold: 0.75,
    searchTopK: 10,
    consolidation: { enabled: true, weeklyThreshold: 4, monthlyThreshold: 4, schedule: "0 3 * * *" },
    decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 },
    deduplication: { enabled: true, similarityThreshold: 0.85 },
    tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 },
    episodes: { archivalAgeDays: 90 },
  })),
  heartbeat: heartbeatConfigSchema.default(() => ({
    enabled: true,
    intervalSeconds: 60,
    checkTimeoutSeconds: 10,
    contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75, zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 } },
  })),
  threads: threadsConfigSchema.default(() => ({
    idleTimeoutMinutes: 1440,
    // Phase 99 sub-scope N (2026-04-26) — lowered from 10 to 3.
    // See threadsConfigSchema comment above for context.
    maxThreadSessions: 3,
  })),
  // Phase 999.14 MCP-09 — idle threshold for the periodic stale-binding
  // sweep. Format: "24h" / "6h" / "30m" / "0" ("0" disables sweep entirely).
  // Default "24h" surfaces today's incident pattern (fin-client's 22h+
  // bindings) without surprising operators. The sweep runs on the same 60s
  // tick as the MCP-03 orphan reaper, AFTER the orphan reap completes.
  threadIdleArchiveAfter: z
    .string()
    .optional()
    .describe(
      "Idle duration after which stale Discord thread bindings get auto-archived (e.g. '24h', '6h', '30m'); '0' disables. Default '24h'.",
    ),
  // Phase 109-B — orphan-claude reaper config. Alert-only by default for the
  // first ~7 days post-deploy so operators can audit the false-positive rate
  // before flipping to "reap". Hot-reload via ConfigReloader; takes effect
  // on the next 60s tick without daemon restart.
  orphanClaudeReaper: z
    .object({
      mode: z.enum(["off", "alert", "reap"]).default("alert"),
      // 120s = 4× the polled-discovery budget (MCP_POLL_INTERVAL_MS×MCP_POLL_MAX_ATTEMPTS
      // = 30s in src/manager/session-manager.ts). The previous default of 30s exactly
      // matched the discovery budget, leaving zero buffer — under contended parallel
      // boots the reaper killed legitimate-but-not-yet-tracked claude subprocesses.
      // Pinned by the structural-invariant test in
      // src/mcp/__tests__/orphan-claude-reaper.test.ts.
      minAgeSeconds: z.number().int().positive().default(120),
    })
    .optional(),
  // Phase 999.25 — subagent completion relay. Decouples
  // `relayCompletionToParent` (operator-channel notification) from
  // session-end. Two new triggers: the `subagent_complete` MCP tool
  // (explicit signal from skill author) and a quiescence-timer sweep
  // (60s onTickAfter). `completedAt` on the ThreadBinding dedupes the
  // three trigger paths (tool / quiescence / session-end). Hot-reload
  // works post-PR #8 (closure-capture fix).
  subagentCompletion: z
    .object({
      enabled: z.boolean().default(true),
      quiescenceMinutes: z.number().int().positive().default(5),
      // Quiescence-relay rollback knob. Default true — the sweep fires
      // `relayCompletionToParent` when a subagent has been idle for
      // `quiescenceMinutes` AND its binding has both `lastDeliveryAt`
      // stamped AND `producedRealContent: true`. Flip to false to fall
      // back to observational-only behaviour (idle warning only — the
      // pre-fix state) without touching the rest of the completion
      // subsystem. Mirrors the Phase 110 `shimRuntime` and Phase 117
      // `advisor.backend` rollback patterns.
      relayOnQuiescence: z.boolean().default(true),
    })
    .optional(),
  // Phase 999.X — subagent-thread reaper. Auto-spawned subagent threads
  // (SubagentThreadSpawner-named, see src/manager/subagent-name.ts) are
  // one-shot delegated tasks; they should self-prune after the Discord
  // thread goes idle but today nothing stops them. The fleet evidence
  // (admin-clawdy 2026-05-04) showed two such threads running 8h+/13h+
  // after their work completed. Hot-reload via ConfigReloader; takes
  // effect on the next 60s tick. Default mode "reap" — the screenshot
  // shows real leaks today, so we act on first tick rather than running
  // alert-only first (operator decision). Env kill-switch:
  // CLAWCODE_SUBAGENT_REAPER_DISABLE=1.
  subagentReaper: z
    .object({
      mode: z.enum(["off", "alert", "reap"]).default("reap"),
      idleTimeoutMinutes: z.number().int().positive().default(1440),
      minAgeSeconds: z.number().int().positive().default(300),
    })
    .optional(),
  // Phase 109-D — fleet-wide observability config. cgroupSampling reads
  // /sys/fs/cgroup/system.slice/clawcode.service/memory.{current,max}; toggle
  // off on hosts where cgroup v2 isn't mounted (the reader degrades to null
  // gracefully anyway, but operators can disable explicitly).
  observability: z
    .object({
      cgroupSampling: z.boolean().default(true),
      cgroupAlertPercent: z.number().int().positive().max(100).default(80),
    })
    .optional(),
  // P3 (memory program) — SpawnGovernor: class-aware admission gate for
  // managed claude-CLI spawns (bounds concurrent SPAWNS, not residency).
  // Defaults single-sourced from SPAWN_GOVERNOR_DEFAULTS (spawn-governor.ts);
  // whole-block omission → the governor uses the same constants. All knobs
  // live-read per acquire → RELOADABLE. `agent` class is advisory-only by
  // design (restart/wedge-recovery must never hard-block).
  spawnGovernor: z
    .object({
      enabled: z.boolean().default(true),
      memoryWatermarkPercent: z.number().min(1).max(100).default(85),
      admissionTimeoutMs: z.number().int().min(1_000).default(120_000),
      queueDepthPerClass: z.number().int().min(1).default(16),
      maxResidentForks: z.number().int().min(1).default(4),
      /**
       * 999.106 G-2 — PSI gate-tighten lines (cgroup memory.pressure). Both
       * gates (SpawnGovernor enforce classes + the workflow admission gate)
       * add a deny condition when `full avg10` or `some avg60` crosses these.
       * 10.0 sits far below memwatch's PSI kill line (50) — admission
       * tightens BEFORE the box stalls hard enough to be worth killing.
       * Defaults mirror SPAWN_GOVERNOR_DEFAULTS (single-sourced there).
       * Floored ABOVE 0 (G-2 review): the gates compare `psi >= threshold`
       * and the fleet baseline is exactly 0.00, so a configured 0 would be
       * ALWAYS-TIGHTEN (fleet-wide spawn breakage), not "off" — same
       * degenerate-value convention as memoryWatermarkPercent's min(1).
       * The gates additionally treat <=0 as leg-disabled (defense in depth).
       */
      gateTightenPsiFull10: z.number().min(0.1).max(100).default(10),
      gateTightenPsiSome60: z.number().min(0.1).max(100).default(10),
      classes: z
        .record(
          z.enum(["agent", "worker", "fork", "pool"]),
          z.object({
            maxConcurrentSpawns: z.number().int().min(1).optional(),
            mode: z.enum(["advisory", "enforce"]).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
  // P2 (memory program) — per-agent `clawcode mcp` sidecar runtime dial.
  // "bundled" = classic `clawcode mcp` (full 4.4 MB CLI bundle, ~246 MB
  // RSS per agent); "slim" = `node dist/channels/clawcode-mcp-standalone.js`
  // (MCP SDK + IPC client only). Default "bundled" keeps the fleet
  // byte-identical until the canary verifies; flip fleet-wide with
  // `defaults.sidecarRuntime.clawcodeMcp: slim`. Spawn-time (baked into
  // claude argv) → takes effect per agent at next session respawn.
  // Same canary-dial pattern as Phase 110 shimRuntime.
  // 999.143 — the daemon-side watcher that turns Unraid pipeline progress into
  // a live card in the owning agent's channel and delivers the finished
  // transcript. Trees themselves stay declared on the `transcribe` MCP server.
  transcription: z
    .object({
      watcher: z.boolean().default(true),
      pollSeconds: z.number().int().min(5).max(300).default(15),
      sshTarget: z.string().min(1).default("root@10.0.0.1"),
      // tree name -> agent, for trees whose name is not the agent's name.
      treeAgents: z.record(z.string(), z.string()).optional(),
      // job-id prefix -> agent, for trees shared by convention.
      jobPrefixAgents: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  // 999.147 WS-3 — memory pressure on the Unraid box. Nothing watched it
  // before; it has no PSI and no swap, so trajectory is the only imminence
  // signal available and `/var/log` (a 128MB tmpfs whose filling kills the
  // webGUI) is the one legitimate level rule. OFF by default: it opens an SSH
  // hop, which must be an explicit operator decision.
  unraidWatch: z
    .object({
      enabled: z.boolean().default(false),
      sshTarget: z.string().min(1).default("root@10.0.0.1"),
      pollIntervalMs: z.number().int().min(60_000).default(300_000),
      alertCooldownMs: z.number().int().min(300_000).default(3_600_000),
      /** MemAvailable floor (MB) the falling trend is projected against. */
      floorMb: z.number().int().min(256).default(2048),
      /** Projected minutes-to-floor that counts as imminent. */
      etaMinutes: z.number().min(1).max(240).default(15),
      sustainSamples: z.number().int().min(1).max(20).default(2),
      /** `/var/log` tmpfs percentage that pages. */
      logPctWarn: z.number().min(50).max(100).default(90),
      windowMs: z.number().int().min(300_000).default(1_800_000),
    })
    .optional(),
  sidecarRuntime: z
    .object({
      clawcodeMcp: z.enum(["bundled", "slim"]).default("bundled"),
    })
    .optional(),
  // 2026-07-31 — MemoryGuard (alert-only cgroup memory watchdog; see
  // src/manager/memory-guard.ts). Defaults mirror MEMORY_GUARD_DEFAULTS
  // (single-sourced there — the runtime falls back to the same object when
  // this block is absent). All knobs read per-tick → RELOADABLE.
  // Auto-remediation deliberately has NO config surface yet (alert-only
  // build; same discipline as the advisor portable-fork exclusion).
  memoryGuard: z
    .object({
      enabled: z.boolean().default(true),
      sampleIntervalMs: z.number().int().min(10_000).default(60_000),
      summaryIntervalMs: z.number().int().min(60_000).default(600_000),
      warnPct: z.number().min(0.1).max(1).default(0.8),
      critPct: z.number().min(0.1).max(1).default(0.9),
      alertCooldownMs: z.number().int().min(60_000).default(21_600_000),
      hostMinAvailableMb: z.number().int().min(0).default(2048),
      hostMinRootDiskFreeGb: z.number().min(0).default(5),
      /**
       * 999.106 QW-6 (INC-2026-08-14 ugrep balloon) — anon+swap watch lines.
       * `balloonWarnMb`: single-proc RssAnon+VmSwap attribution line (fires
       * `proc:anon-balloon`, structural, warn-tier — memwatch owns the kill).
       * `swapWarnMb`: cgroup memory.swap.current warn line (of the 2G
       * MemorySwapMax). Defaults mirror MEMORY_GUARD_DEFAULTS — keep in
       * lockstep (memory-guard.ts).
       */
      balloonWarnMb: z.number().int().min(256).default(4096),
      swapWarnMb: z.number().int().min(64).default(1024),
      /**
       * 999.106 G-2 — gate-tighten signal knobs. `gateBalloonMb`: single-proc
       * anon+swap line above which MemoryGuard's census publishes
       * anonBalloon:true on the MemorySignalBus (admission DEFERS — distinct
       * job from balloonWarnMb's alert page). `signalMaxAgeMs`: staleness
       * window the gates apply to the published signal (default 3 census
       * ticks; stale ⇒ ignored, fail-open). Defaults mirror
       * MEMORY_GUARD_DEFAULTS — keep in lockstep (memory-guard.ts).
       */
      gateBalloonMb: z.number().int().min(256).default(4096),
      signalMaxAgeMs: z.number().int().min(60_000).default(180_000),
      /**
       * WS4 (2026-09-02) — corroboration gate on the DISCORD leg. When true
       * (default), a warn-tier breach only posts to #admin-clawdy if
       * independent kernel evidence supports it (a reclaim/throttle event
       * since the last sample, or PSI over the thresholds in
       * memory-pressure.ts). Critical-tier and STRUCTURAL breaches are never
       * gated, and the check FAILS OPEN when PSI is unavailable.
       *
       * Suppressed breaches still log (`memory-guard breach suppressed`) and
       * still occupy their alertState slot, so cooldowns and warn→critical
       * escalation are unchanged. Set false to restore pre-WS4 behavior.
       *
       * NOTE this only filters what the guard emits — it cannot create a page
       * that never fired. The 6h alertCooldownMs swallowing a real escalation
       * (INC 2026-08-14) is a separate, still-open problem.
       */
      corroborateWarnings: z.boolean().default(true),
      /**
       * 999.147 — three-tier alert router (memory-imminence.ts). When true
       * (default) a breach reaches #admin-clawdy only if its tier says so:
       * `page` (imminence — instant, carries the relief button), `digest`
       * (one rollup message a day), `telemetry` (journal only).
       *
       * Set false to restore the pre-999.147 behaviour where every breach that
       * clears the corroboration gate posts instantly. Independent of
       * `corroborateWarnings` — both must be false to get the original
       * 2026-07-31 firehose back.
       */
      tiering: z.boolean().default(true),
      /**
       * 999.147 — per-key tier overrides. Keys are exact breach keys
       * (`"total:pct"`) or class-rule wildcards (`"class:*:rss"`); exact wins.
       * The operator escape hatch for promoting or demoting one rule
       * mid-incident without a deploy.
       */
      alertTiers: z
        .record(z.string(), z.enum(["page", "digest", "telemetry"]))
        .optional(),
      /**
       * 999.147 — imminence thresholds. `anonCritPct`/`anonWarnPct` measure
       * ANON against the ceiling, not `memory.current`: the 2026-09-16
       * `cgroup at 97%` page carried only 6524MB of anon, the rest being
       * reclaimable page cache. `etaMinutes` is the projected time-to-ceiling
       * that counts as imminent; `sustainSamples` the consecutive ticks a
       * trajectory breach must hold. Defaults mirror IMMINENCE_DEFAULTS —
       * keep in lockstep (memory-imminence.ts).
       */
      imminence: z
        .object({
          anonCritPct: z.number().min(0.1).max(1).default(0.85),
          anonWarnPct: z.number().min(0.1).max(1).default(0.75),
          etaMinutes: z.number().min(1).max(240).default(10),
          sustainSamples: z.number().int().min(1).max(20).default(2),
          windowMs: z.number().int().min(120_000).default(900_000),
          // NO default: the host floor is single-sourced from
          // `hostMinAvailableMb` above, so raising that one knob cannot open a
          // gap between "already below the floor" (host:mem) and "projected to
          // reach the floor" (imminent:host-exhaustion). Set it only to make
          // the projection deliberately more or less eager than the level rule.
          hostFloorMb: z.number().int().min(0).optional(),
        })
        .optional(),
      /** 999.147 — how often the digest tier flushes. Default 24h. */
      digestIntervalMs: z.number().int().min(600_000).default(86_400_000),
      /**
       * 999.147 — anti-machine-gun floor between two `actNow` pages of the
       * same key. `actNow` (kernel stalling, or an OOM kill just happened)
       * deliberately bypasses `alertCooldownMs` — that is the INC-2026-08-14
       * fix, where a benign 84% warn opened a 6h window that swallowed the
       * page that mattered — so it needs its own, much shorter, bound.
       */
      actNowCooldownMs: z.number().int().min(60_000).default(900_000),
      /**
       * Per-class budget overrides, e.g. `npm: { maxCount: 2 }`. Classes
       * without an entry use DEFAULT_CLASS_BUDGETS (memory-guard.ts).
       */
      classBudgets: z
        .record(
          z.string(),
          z.object({
            maxRssMb: z.number().int().min(1).optional(),
            maxCount: z.number().int().min(0).optional(),
            // INC-2026-08-09 — browser-INSTANCE ceiling for multi-process
            // classes (chrome). Where set it REPLACES maxCount as the alerting
            // rule. Zod strips unknown keys, so this must stay in lockstep with
            // ClassBudget in memory-guard.ts or an operator's override is
            // dropped with no error.
            maxInstances: z.number().int().min(0).optional(),
            maxProcs: z.number().int().min(1).optional(),
            // 999.106 QW-6 — class ceiling on summed RssAnon+VmSwap (what a
            // VmRSS budget cannot see once pages hit swap). Same lockstep
            // rule as maxInstances above.
            maxAnonSwapMb: z.number().int().min(1).optional(),
            kind: z.enum(["structural", "proxy"]).optional(),
          }),
        )
        .optional(),
      /**
       * P4 (memory program) — remediation surface. TWO-PLANE RULE: budgets
       * above only ever ALERT; the reapers gated here act ONLY on structural
       * orphan signals (ppid-1 + not-in-registry, orphaned parent, over-cap).
       * Tighten-only semantics live in src/manager/reap-policy.ts:
       * `enabled: false` clamps NON-grandfathered classes to ≤ alert;
       * mcp-orphan/chrome/sub are grandfathered at "reap" (pre-P4 shipped
       * behavior) and only an explicit per-class "off"/"alert" changes them.
       * New classes (survivor-cli, npm, fork, pool) default "off" — rollout
       * is config-driven: off → alert (observe a week) → reap.
       * Env kill-switch CLAWCODE_REMEDIATION_DISABLE=1 clamps EVERYTHING
       * (grandfathered included) to ≤ alert without a config edit.
       */
      remediation: z
        .object({
          enabled: z.boolean().default(false),
          // partialRecord: enum-keyed z.record is exhaustive in Zod 4 —
          // operators set only the classes they're flipping.
          classes: z
            .partialRecord(
              z.enum([
                "mcp-orphan",
                "chrome",
                "sub",
                "survivor-cli",
                "npm",
                "fork",
                "pool",
              ]),
              z.enum(["off", "alert", "reap"]),
            )
            .optional(),
        })
        .optional(),
    })
    .optional(),
  // Phase 109-C — broker pooling kill-switch. Phase 108 keeps `enabled: true`
  // by default since the broker is LIVE in production; surfaced here so an
  // operator can flip to false at runtime if the pool misbehaves under load.
  brokerPooling: z
    .object({
      enabled: z.boolean().default(true),
    })
    .optional(),
  // Phase 110 Stage 0a → Stage 0b — per-shim-type runtime selector. Each
  // entry picks the runtime the loader-auto-injected `clawcode {search,
  // image,browser}-mcp` shim spawns under. Stage 0a shipped the dial
  // wired end-to-end with a single value ("node" — current behavior);
  // Stage 0b widens the enum (DONE — see PR landing this commit) to
  // ["node","static","python"] so an operator can flip a flag and the
  // loader rewrites command/args without a daemon restart.
  //
  // - "node":   current behavior — `clawcode <type>-mcp` Node shim (~147 MB RSS each)
  // - "static": Go binary at /opt/clawcode/bin/clawcode-mcp-shim --type <type> (target <10 MB RSS)
  // - "python": (reserved) python3 translator at /opt/clawcode/bin/clawcode-mcp-shim.py;
  //             no implementation in Stage 0b. Widening the enum together
  //             with "static" lets a future Python pivot ship without
  //             another schema migration.
  //
  // Default "static" (2026-07-31 memory-pressure fix): the Go shim has
  // been the intended production runtime since the Phase 110 Stage 0b
  // rollout, but the built-in "node" fallback meant any agent without an
  // explicit per-agent flag silently spawned three ~240 MB Node shims —
  // 5 drifted agents cost ~3.6 GB of the daemon cgroup. "node" remains
  // fully supported as the emergency-rollback runtime; selecting it now
  // requires explicit YAML and emits a `phase110-shim-resolver` warn per
  // resolution (see resolveRuntime in ./loader.ts). Per-type independence
  // — search can flip while image stays — is unchanged.
  //
  // Crash-fallback policy (LOCKED): if a "static" spawn fails, fail
  // loud — do NOT auto-fall-back to "node". Surface the failure to the
  // operator. Loader code intentionally contains no try/catch around
  // the alternate-runtime path.
  shimRuntime: z
    .object({
      search: z.enum(["node", "static", "python"]).default("static"),
      image: z.enum(["node", "static", "python"]).default("static"),
      browser: z.enum(["node", "static", "python"]).default("static"),
      // P5 (Stage 0c, operator-unlocked 2026-08-03) — 1password broker
      // shim runtime. "static" = Go byte-pipe (--type 1password);
      // "node" = classic full-bundle rollback (~240 MB RSS/agent).
      broker: z.enum(["node", "static"]).default("static"),
    })
    .optional(),
  /**
   * Workflow-worker admission control (2026-06-27 OOM fix). The daemon-side
   * `start_workflow` orchestrator fans out in-process `anthropic-agent-sdk`
   * workers; with no global bound a multi-step / multi-workflow burst drove the
   * daemon heap past the 20G cgroup MemoryMax and OOM-killed the whole fleet.
   * These bounds are read live by the WorkflowAdmissionGate on each worker
   * admission (across ALL workflows — the orchestrator is a singleton).
   *
   * Restart-applied (config = file-save only; there is no `clawcode reload`).
   *
   * Sizing: idle fleet ≈ 9.5G, ceiling 20G → ≈ 10.5G headroom. Default cap 3
   * budgets ≈ 3.5G/worker — conservative for the first deploy since a large
   * Opus turn (big context + web-search tool results) can exceed the ~1.3G
   * measured WHILE RAMPING in the incident. The watermark is the adaptive hard
   * backstop (≈ 17G at 85%). NOTE: the watermark gates ADMISSION, not the
   * in-flight climb of already-admitted workers, so the cap × peak-per-worker
   * product is the real bound — calibrate the cap upward only after measuring
   * peak cgroup memory per worker on a real workflow.
   *
   * admissionTimeoutMs 900s → 3600s (INC-2026-07-26): the old value was
   * numerically IDENTICAL to the 15-min stall-tracker max-pause ceiling, so a
   * single wedged slot-holder consumed a queued step's entire admission
   * window — 10 of 15 client-a-personal steps starved, missing a freed slot by
   * ~62s. Waiters hold NO session memory (the orchestrator spawns a worker
   * only after acquire resolves), so a longer wait is OOM-neutral — it
   * trades step latency for step survival. The workflow-level wall clock and
   * stall recovery still bound total workflow lifetime.
   */
  // 999.103 WS-1 — fleet default for the TodoWrite mirror (per-agent override
  // below cascades whole-object, like other per-agent blocks).
  todoMirror: todoMirrorSchema.optional(),
  // 999.105 — fleet default output style (per-agent outputStyle cascades over it).
  outputStyle: outputStyleSchema.optional(),
  workflow: z
    .object({
      maxConcurrentWorkers: z.number().int().min(1).max(16).default(3),
      memoryHighWatermarkPercent: z.number().min(1).max(100).default(85),
      admissionTimeoutMs: z.number().int().min(1000).default(3_600_000),
      /**
       * How many workflow artifact directories to retain per agent workspace.
       * Pruned oldest-first at finalize. Nothing pruned these before
       * INC-2026-08-10, and the report PDFs add to what accumulates.
       */
      keepArtifactDirs: z.number().int().min(1).max(1000).default(40),
      /**
       * Phase 999.128 — fleet-wide named workflow templates, launchable by
       * any agent with `start_workflow({ template, params })`. Per-agent
       * `workflowTemplates` entries override same-named ones.
       */
      templates: z.array(workflowTemplateSchema).optional(),
      /**
       * INC-2026-08-10 — how a completed workflow is delivered to the channel.
       *
       * `"summary"` (default): ONE consolidated post. `"inline"`: the pre-fix
       * behavior — every worker result concatenated and chunked, which turned a
       * 4-step fin-client run into ~51 sequential Discord messages.
       * `inline` exists solely as an operator rollback; it is not a mode anyone
       * should choose deliberately.
       *
       * NOTE: `workflow` is `.optional()` and prod YAML has no `workflow:` key,
       * so the `??` fallbacks in daemon.ts getWorkflowLimits are the EFFECTIVE
       * production defaults. A default declared here alone would never apply.
       */
      /**
       * 999.106 QW-2 (worker diet) — per-worker resource ceiling.
       *
       * `worker.mcpServers` is a fail-closed allowlist of MCP server NAMES a
       * workflow worker keeps from its parent's roster. Measured 08-14: a
       * worker inheriting the full roster drags ~540MB of sidecars per
       * session; a slim worker is ~300MB all-in. ABSENT = inherit the full
       * parent roster (pre-QW-2 behavior — the safe first-deploy default);
       * `[]` = tool-free workers fleet-wide. Set this only AFTER the per-step
       * canary (`steps[].mcpServers` on start_workflow) has measured the
       * delta for your workloads — a research step stripped of its servers
       * still reports "done", just with silently degraded results.
       * Deliberately NO .default(): absence is meaningful (inherit), so there
       * is no schema/daemon fallback pair to drift.
       */
      worker: z
        .object({
          mcpServers: z.array(z.string()).optional(),
        })
        .optional(),
      output: z
        .object({
          mode: z.enum(["summary", "inline"]).default("summary"),
          /**
           * Render and attach the two report PDFs (brief + complete record)
           * alongside the summary. Set false to turn the browser render off
           * fleet-wide without a code change - the summary post is unaffected
           * either way, since attachments are strictly an enrichment.
           */
          reports: z.boolean().default(true),
          /**
           * Run an LLM synthesis turn to edit the brief (bottom line, key
           * findings, per-step condensation) before rendering. False publishes
           * the deterministic composition, which is complete but unedited.
           */
          synthesis: z.boolean().default(true),
          /**
           * Phase 999.123 — fleet default for the fact-check step. `auto`
           * (default) and `off` = off; `on` forces it fleet-wide. Per-agent
           * `workflowVerifyFigures` overrides.
           */
          verifyFigures: z.enum(["auto", "on", "off"]).default("auto"),
        })
        .optional(),
    })
    .optional(),
  /**
   * INC-2026-07-27 — 1Password outage fallback.
   *
   * `envFallback` maps an `op://` URI to the NAME of an environment variable
   * (supplied via the systemd `EnvironmentFile`, i.e. the already-blessed
   * on-box secret store) that holds the same value. It is consulted ONLY
   * after a live `op read` fails, so normal operation is unchanged and
   * 1Password stays the source of truth.
   *
   * WHY: on 2026-07-27 a rate-limited service account made a daemon restart
   * resolve 0/17 refs; `fin-client` and `fin-research` could not start
   * because their 1password MCP token is itself an `op://` ref — an
   * unbreakable chicken-and-egg during an outage. An explicit map (rather
   * than derived env names) keeps it auditable: an operator can see exactly
   * which secrets have an outage path.
   *
   * ROTATION LANDMINE: a rotated secret must be updated in BOTH 1Password and
   * the env file, or an outage will silently serve the old value. The
   * resolver logs loudly whenever a fallback serves.
   */
  secrets: z
    .object({
      envFallback: z.record(z.string(), z.string()).default(() => ({})),
      /** Consecutive rate-limited failures before op reads are suppressed. 0 disables. */
      breakerThreshold: z.number().int().min(0).default(3),
      /** How long op reads stay suppressed once the breaker opens. */
      breakerCooldownMs: z.number().int().min(1000).default(300_000),
      /**
       * Maximum age of a last-known-good (LKG) entry that may still be served
       * when a live `op read` fails. Beyond it the resolver REFUSES the stale
       * value and the read fails as if no fallback existed. 0 disables the
       * check (serve an entry of any age — the behavior before this knob).
       *
       * SEMANTICS LANDMINE — this is NOT "age of the secret". `savedAt` is
       * written only on a SUCCESSFUL LIVE read, and `resolve()` short-circuits
       * on the in-memory cache, so an entry's age tracks DAEMON UPTIME since
       * that URI was last read live (≈ time since the last restart), not how
       * long ago the credential was rotated. Tune against the longest
       * realistic gap between daemon restarts, NOT against a rotation policy:
       * a value shorter than that gap refuses LKG during exactly the
       * restart-mid-outage scenario the store exists for.
       *
       * WHY enforce at all: a secret DELETED or rotated in 1Password fails
       * every live read forever, and its frozen `savedAt` would otherwise let
       * the daemon replay that dead credential indefinitely with no end state.
       *
       * Default 30d = 2_592_000_000 ms — multiples of both the 24h 1Password
       * rate-limit window and this fleet's deploy-restart cadence. Keep in
       * sync with `DEFAULT_LKG_MAX_AGE_MS` in src/manager/secrets-resolver.ts
       * (the manager layer is downstream of the schema, so the literal is
       * duplicated rather than imported).
       *
       * Restart-applied (config = file-save only).
       */
      lkgMaxAgeMs: z.number().int().min(0).default(2_592_000_000),
      /**
       * WS-5 (2026-08-28) — FRESH-SERVE window for the last-known-good store.
       *
       * An LKG entry younger than this (now − savedAt ≤ lkgFreshMs) is served
       * at resolve time WITHOUT a live `op read`. 0 (default) = today's
       * behaviour: the store is consulted only after a live read fails, and
       * every daemon restart reads every `op://` ref live.
       *
       * WHY: prod holds 32 `op://` refs, so each restart costs ~30 reads
       * against the 1,000/24h cap that is SHARED across every service
       * account on the 1Password account (INCIDENT-1p-ratelimit-2026-08-08).
       * A deploy day with several restarts re-reads the same unchanged values
       * over and over. With a 12h window (43_200_000) the second and later
       * restarts of the day cost zero reads.
       *
       * ROTATION: a rotated secret is NOT picked up until the entry ages out
       * of the window. Force it with `clawcode secrets refresh [uri]` (IPC
       * `secrets-refresh`), which drops the entry and reads live immediately.
       *
       * The effective window is clamped to `lkgMaxAgeMs` — an entry the
       * outage path would refuse as too old is never served as "fresh".
       * `savedAt` only advances on a LIVE read, never on a fresh serve.
       *
       * Restart-applied (config = file-save only).
       */
      lkgFreshMs: z.number().int().min(0).default(0),
    })
    .optional(),
  /**
   * Phase 999.99 — fleet-wide SDK deny-list. Names listed here are forwarded
   * to the SDK's `disallowedTools` option (via the loader resolver →
   * ResolvedAgentConfig → AgentSessionConfig → session-adapter create/resume),
   * so the LLM physically cannot invoke them.
   *
   * Default `["ScheduleWakeup", "CronCreate"]` blocks the two leaky SDK
   * self-fire tools that DROVE the recurring-poll delivery gap: a turn fired
   * by ScheduleWakeup/CronCreate runs OUTSIDE the daemon's turn collector, so
   * its output buffers in the shared `driverIter` and drains one-per-inbound
   * message (CONTEXT §2c — the operator's "I have to keep prompting to flush
   * out the buffered poll responses" symptom). With the tools gone, the model
   * is forced onto the delivered `schedule_recurring` primitive (Plan 01),
   * whose ticks post via the trigger-delivery path.
   *
   * `Monitor` is DELIBERATELY NOT in the default array — it is STEERED, not
   * blocked (CONTEXT §7 Q3). Its legitimate non-poll use is unverifiable
   * in-tree, so blocking it is the reversible-via-config fallback an operator
   * can opt into (append `"Monitor"` here) rather than a default. The
   * system-prompt steer (session-config.ts discordBindingsStr block) is the
   * redirect for Monitor-style polls.
   *
   * **NON-RELOADABLE** — this deny-list is BAKED INTO the SDK
   * session at create/resume (session-adapter.ts:1646/1832). A YAML flip
   * therefore takes effect for a RUNNING PRIMARY agent only on a daemon
   * RESTART (subagent spawns pick up the new value on their next spawn). Do
   * NOT expect `clawcode reload` to apply a change to this field for a live
   * primary session.
   *
   * `.default([...]).optional()` mirrors the `streamStallTimeoutMs` shape
   * below: the field is `string[] | undefined` at the type level so existing
   * DefaultsConfig test factories compile without an explicit entry, and the
   * loader resolver materializes the floor with `?? ["ScheduleWakeup",
   * "CronCreate"]` at consumption time.
   */
  // Phase 145 WS3 — "AskUserQuestion" added to the fleet floor. The built-in
  // AskUserQuestion renders nothing in the Discord/Slack bridge (the agent
  // believes it asked; the user sees nothing), so it is disallowed fleet-wide
  // and replaced by the namespaced MCP `ask_user_question` tool (Plan 04, no
  // name collision). This floor propagates to ClawCode subagents via the
  // 999.99 union at subagent-thread-spawner.ts:1420 — no spawner edit needed.
  disallowedTools: z
    .array(z.string())
    .default(["ScheduleWakeup", "CronCreate", "AskUserQuestion"])
    .optional(),
  // Phase 127 — fleet-wide stream-stall supervisor threshold (ms). Default
  // 180000ms (3 min) — owned by quick task 260521-3or, which made the
  // tracker tool-aware (tool-execution time is excluded from the stall)
  // and reverted the 15r 600_000 band-aid back to this baseline. Cascade
  // lookup order in loader:
  //   agent.streamStallTimeoutMs ??
  //   defaults.modelOverrides[agent.model].streamStallTimeoutMs ??
  //   defaults.streamStallTimeoutMs (this value)
  // Reloadable — tracker re-reads on each setInterval tick.
  //
  // `.optional()` after `.default(180_000)` mirrors the Phase 999.6
  // preDeploySnapshotMaxAgeHours / Phase 999.12 heartbeatInboxTimeoutMs
  // pattern above — z.infer<typeof defaultsSchema>.streamStallTimeoutMs
  // becomes `number | undefined` at the type level so existing
  // DefaultsConfig test factories continue to compile without an explicit
  // entry; the loader resolver uses `?? 180_000` to materialize the
  // baseline at consumption time.
  streamStallTimeoutMs: z
    .number()
    .int()
    .min(30_000)
    .max(1_800_000)
    .default(180_000)
    .optional(),
  // Phase 145 WS2 — fleet-wide override for the absolute turn-duration
  // ceiling. No `.default(...)` here (unlike streamStallTimeoutMs): the
  // resolver materializes the 20-min DEFAULT_MAX_TURN_DURATION_MS floor at
  // consumption time, so omitting this key leaves the fleet byte-identical
  // (no agent's ceiling moves). min == the 20-min default (can only lift),
  // max 8h finite (see the agent-level field comment). Reloadable.
  maxTurnDurationMs: z
    .number()
    .int()
    .min(1_200_000)
    .max(28_800_000)
    .optional(),
  // Phase 127 — per-model stream-stall threshold overrides. Operators set
  // Opus longer (e.g. 300000ms) to cover advisor consults and Haiku shorter
  // (e.g. 90000ms) since Haiku turns are expected to be fast. The resolver
  // cascade picks up the entry keyed by the agent's resolved model; an
  // agent-level `streamStallTimeoutMs` still beats this. Reloadable.
  //
  // Phase 145 WS2 — the per-model record also carries an optional
  // `maxTurnDurationMs` so a fleet can lift the duration ceiling for one
  // model class (e.g. Opus orchestrators) without touching the others. Same
  // cascade position as streamStallTimeoutMs: an agent-level
  // `maxTurnDurationMs` beats this entry, which beats `defaults.maxTurnDurationMs`.
  // Phase 999.114 — keyed by FAMILY, widened from the 3-key set to include
  // `fable`. The Phase 999.98 note said this block "never gains a fable key";
  // that decision produced a live incident (fin-research's 180s stall watchdog
  // firing with `streamStallTimeoutMs` unreachable for fable), and Fable is now
  // both the default top tier AND the slowest model in the lineup, so a longer
  // stall ceiling is exactly what it needs. Historical pins normalize to their
  // family at the lookup (loader.ts), so `opus-4-6` reads the `opus` entry.
  // 🚨 `partialRecord`, NOT `record`: in Zod v4 a `z.record()` with an ENUM key
  // is EXHAUSTIVE — every key becomes REQUIRED. Adding "fable" to the key set
  // under a plain `z.record` made a `fable:` entry mandatory in every config
  // that defines modelOverrides at all, i.e. a boot-time config-parse failure
  // for an operator who overrides only one model class. (Prod does not define
  // the block today, so nothing was live-broken — the loader-145 suite caught
  // it.) `partialRecord` keeps every key optional, which is the intent.
  modelOverrides: z
    .partialRecord(
      z.enum(["haiku", "sonnet", "opus", "fable"]),
      z.object({
        streamStallTimeoutMs: z
          .number()
          .int()
          .min(30_000)
          .max(1_800_000)
          .optional(),
        maxTurnDurationMs: z
          .number()
          .int()
          .min(1_200_000)
          .max(28_800_000)
          .optional(),
      }),
    )
    .optional(),
  // Phase 145 WS1 — fleet-wide default for the subagent permission-hook
  // gate. Default OFF (resolver `?? false`); omitting the key leaves the
  // fleet byte-identical. An agent-level `subagentPermissionGate` beats this.
  subagentPermissionGate: z.boolean().optional(),
  // WS-1 (999.99 structural delivery) — fleet-wide delivery defaults.
  // `attributedStream` default false (canary-first: flip per-agent, then
  // here). An agent-level `delivery.attributedStream` beats this.
  // NON-RELOADABLE (session-spawn read).
  delivery: z
    .object({
      attributedStream: z.boolean().optional(),
    })
    .optional(),
  // Phase 117 Plan 06 — fleet-wide advisor block. Mirrors the shimRuntime
  // canary dial: `.optional()` so omission yields `undefined` (operators on
  // pre-117 configs see no behavior change at parse time; loader resolvers
  // fall through to the hardcoded baseline {backend:"native", model:"opus",
  // maxUsesPerRequest:3, caching:{enabled:true,ttl:"5m"}}). When an
  // operator DOES supply a block, advisorConfigSchema's inner defaults
  // populate any omitted sub-fields. Wave-4 Plan 117-04 reads the resolved
  // model to wire `Options.advisorModel`; Plan 117-07 reads the resolved
  // backend to gate IPC dispatch; Plan 117-08 reads the same backend for
  // the capability manifest. See `advisorConfigSchema` block above.
  advisor: advisorConfigSchema.optional(),
  /**
   * Phase 999.117 WS-3 — fleet-wide agent-to-agent loop governance.
   * `.optional()` so pre-999.117 configs parse unchanged; when omitted the
   * daemon falls through to DEFAULT_LOOP_GOVERNOR_CONFIG, which is the same
   * set of values this schema defaults to. Declared here in the SAME commit
   * as its first use: `configSchema` drops unknown keys silently, so a knob
   * added to YAML before it exists in the schema is a no-op that looks like
   * a working feature (this has bitten `financialVerification` and
   * `heartbeat.enabled` before).
   */
  a2a: a2aConfigSchema.optional(),
  /**
   * Phase 999.100 — fleet-wide mid-turn steering defaults. Optional at
   * parse time so pre-999.100 configs see no error; the loader cascade
   * (agents[].steering ?? defaults.steering ?? hardcoded baseline) resolves
   * a complete block onto every ResolvedAgentConfig. `autoClassify`
   * defaults false — the feature is opt-in per agent or fleet-wide.
   * RELOADABLE (bridge reads the resolved block per message).
   */
  steering: steeringConfigSchema.optional(),
  /**
   * Phase 999.63 Plan 04 — fleet-wide financial-verification enforcement
   * default (CONTEXT.md D6). Per-agent `agents[].verification`
   * cascades over this. Optional at parse time so pre-Phase-999.63 configs
   * see no error; the loader cascade resolves to `undefined` when neither
   * agent nor defaults supply the block, leaving the resolver on the
   * name-prefix default. RELOADABLE.
   *
   * 2026-07-31 — surface switched to the defaults-bearing schema: the
   * budget knobs (maxVerifyHops / skipIfTurnMsOver / shrinkIfTurnMsOver /
   * deferMs) fill from VERIFICATION_BUDGET_DEFAULTS when the
   * operator writes the block; whole-block omission still yields
   * `undefined` and the runner falls back to the same constants.
   */
  verification: verificationDefaultsSchema.optional(),
  /** DEPRECATED alias for `verification` — see agentSchema for why it
   *  must exist until prod's yaml is migrated (non-strict schema drops
   *  unknown keys silently). */
  financialVerification: verificationDefaultsSchema.optional(),
  /**
   * Phase 136 — fleet-wide LlmRuntime backend baseline.
   *
   * Optional at parse time so pre-Phase-136 configs see no parse error.
   * Loader's `resolveLlmRuntimeBackend` falls through to the hardcoded
   * baseline `"anthropic-agent-sdk"` when neither agent nor defaults
   * supply the block. Phase 137 onwards: operators can flip the whole
   * fleet to a new backend by setting `defaults.llmRuntime.backend` and
   * `clawcode restart`-ing (NON_RELOADABLE — captured into session
   * baseOptions at spawn).
   */
  llmRuntime: llmRuntimeConfigSchema.optional(),
  /**
   * Phase 137 Plan 04 — fleet-wide per-provider credentials block.
   *
   * `providers.openai.apiKeyPath` is the operator-edited path to the
   * OpenAI API key — either an `op://example-vault/item/field` URI (resolved
   * via SecretsResolver) or a plaintext `sk-...` value. Per-agent
   * override at `agents[].providers.openai.apiKeyPath` cascades over
   * this default (loader resolver picks the per-agent value first).
   *
   * Optional at parse time so pre-Phase-137 configs see no error.
   * Loader cascade resolves to `undefined` when neither agent nor
   * defaults supply the field — that's the lazy-fail path: agents
   * flipped to codex-cli with no credentials configured surface a
   * `OpenAiCredentialsMissingError` on their first turn (NOT at boot,
   * to keep daemon startup non-blocking for non-trial agents).
   *
   * RELOADABLE — see types.ts RELOADABLE_FIELDS. Operators rotate
   * the key by editing clawcode.yaml; ConfigWatcher delta detection
   * invalidates the per-agent OpenAiCredentialsResolver cache and the
   * next turn picks up the new value without daemon restart.
   */
  providers: providersConfigSchema.optional(),
  /**
   * Bridge config block (spawned `claude` one-shot helper).
   *
   * Optional at parse time; when omitted `haikuDirectRouting` defaults to
   * "bridge". RELOADABLE — see types.ts RELOADABLE_FIELDS "defaults.bridge".
   *
   * NO per-agent override (advisor reconcile 2026-05-17 — daemon-
   * wide config sufficient; per-agent surface unjustified).
   */
  bridge: bridgeConfigSchema.optional(),
  // Fleet-wide default for the per-agent OS sandbox. Agents inherit unless they
  // set `agents.*.sandbox`. NON_RELOADABLE (captured into the spawn at boot).
  sandbox: sandboxConfigSchema.optional(),
  // Phase 124 Plan 02 D-06 — fleet-wide auto-compaction trigger ratio.
  // Plan 125 consumes the resolved value to decide when to fire compaction
  // automatically; Phase 124 only ships the schema + reload integration.
  // Default 0.7 (70% of context window). Per-agent override via
  // `agentSchema['auto-compact-at']` cascades over this. Hyphenated key
  // matches the YAML surface; the resolved type exposes the camelCase
  // `autoCompactAt` field (see `loader.ts` resolver).
  "auto-compact-at": z.number().min(0).max(1).default(0.7),
  // Phase 125 Plan 02 — fleet-wide defaults for the tier 1 verbatim gate.
  // Optional (consumer-side fallback to 10 / []) for back-compat with
  // existing DefaultsConfig test factories. Per-agent overrides cascade
  // via `agentSchema.preserveLastTurns` / `agentSchema.preserveVerbatimPatterns`.
  preserveLastTurns: z.number().int().min(1).max(100).optional(),
  preserveVerbatimPatterns: z.array(z.string().min(1)).optional(),
  // Phase 115 D-08 + D-09 — embedding-v2 migration knobs. Default values
  // match the Phase 115 D-09 cost discipline: 5% CPU budget, 50-row
  // batch. These are knobs not constants; operator can dial both via
  // hot-reload on a per-fleet basis. The pausedAgents array lets the
  // operator pause migration for one or more agents (independent of the
  // per-agent state machine — agent stays in dual-write/re-embedding,
  // but the heartbeat-driven runner skips it). Schema-only this plan;
  // wave 4's migration kickoff actually wires the runner reads.
  embeddingMigration: z
    .object({
      cpuBudgetPct: z
        .number()
        .int()
        .min(1)
        .max(50)
        .default(5)
        .describe(
          "Phase 115 D-09 — CPU budget for the v2 re-embed batch worker. Default 5%.",
        ),
      batchSize: z
        .number()
        .int()
        .min(10)
        .max(500)
        .default(50)
        .describe(
          "Phase 115 D-08 — re-embed batch size. Default 50 entries per batch.",
        ),
      pausedAgents: z
        .array(z.string())
        .default(() => [])
        .describe(
          "List of agents whose v2 re-embed batch is paused (operator-controlled).",
        ),
    })
    // Optional (mirrors shimRuntime / brokers schema-only-default pattern)
    // — schema ships in this plan, runtime wiring lands in wave 4. Operators
    // who don't override see undefined; the runner fills in the cpuBudgetPct
    // / batchSize / pausedAgents defaults at consumption time.
    .optional(),
  // Phase 115 Plan 07 sub-scope 15 — daemon-side MCP tool-response cache.
  // Folds Phase 999.40 (now SUPERSEDED-BY-115). The cache lives at
  // `~/.clawcode/manager/tool-cache.db` and intercepts repeated tool
  // calls at the IPC dispatch boundary. Per-tool TTL + key-strategy
  // defaults live in `src/mcp/tool-cache-policy.ts:DEFAULT_TOOL_CACHE_POLICY`;
  // operators override per-tool here.
  //
  // Optional (mirrors shimRuntime / brokers / embeddingMigration
  // schema-only-default pattern). When absent, runtime fills in
  // `enabled=true` / `maxSizeMb=100` / empty policy overrides.
  toolCache: z
    .object({
      enabled: z
        .boolean()
        .default(true)
        .describe(
          "Phase 115 sub-scope 15 — master switch. Set false to fully bypass the cache (e.g., debugging tool dispatch).",
        ),
      maxSizeMb: z
        .number()
        .int()
        .min(10)
        .max(10000)
        .default(100)
        .describe(
          "Phase 115 sub-scope 15 — total cache size cap in MB. LRU evicts oldest rows when over cap. Default 100MB.",
        ),
      policy: z
        .record(
          z.string().min(1),
          z.object({
            ttlSeconds: z.number().int().min(0).max(86400).optional(),
            keyStrategy: z
              .enum(["per-agent", "cross-agent", "no-cache"])
              .optional(),
          }),
        )
        .default(() => ({}))
        .describe(
          "Per-tool overrides keyed by tool name. Operator can shorten TTL or flip strategy; cacheable predicate (e.g. mysql_query read-only gate) cannot be patched.",
        ),
    })
    .optional(),
  // Goal-loop (/clawcode-goal) — autonomous "run until the condition is met"
  // loop that duplicates Claude Code's /goal. Per operator decision the limits
  // are SOFT (natural-language clauses in the condition, enforced by the judge
  // each turn); these knobs are only the runaway CIRCUIT-BREAKER (for when the
  // judge itself malfunctions — no human to Ctrl-C an unattended daemon) plus
  // the judge model. Optional — runtime fills defaults when absent.
  goal: z
    .object({
      evaluatorModel: z
        .enum(["haiku", "sonnet", "opus"])
        .default("haiku")
        .describe(
          "Model that judges goal completion after each turn. Haiku is cheap and matches Claude Code /goal's evaluator.",
        ),
      backstopMaxTurns: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .default(100)
        .describe(
          "Runaway circuit-breaker: absolute turn ceiling (NOT the soft UX limit). Trips only when the judge can't stop the loop itself.",
        ),
      backstopMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .default(60)
        .describe("Runaway circuit-breaker: absolute wall-clock ceiling, minutes."),
      turnTimeoutMs: z
        .number()
        .int()
        .min(10_000)
        .max(1_800_000)
        .default(600_000)
        .describe("Per-turn awaitReply timeout, ms. Generous — goal turns do real work."),
    })
    .optional(),
  // Phase 110 Stage 0a — broker dispatch table. Server-id keyed map for
  // generalizing Phase 108's OnePasswordMcpBroker to typed multi-server
  // pools (one broker proc per server-id, N agents → 1 child). Schema
  // only this PR; Stage 1a wires the broker class to read this map and
  // Stage 1b wires the daemon dispatch. Reloadable in classification so
  // the surface is stable; runtime edits are no-ops until Stage 1a.
  brokers: z
    .record(
      z.string().min(1),
      z.object({
        enabled: z.boolean().default(true),
        maxConcurrent: z.number().int().positive().default(4),
        spawnArgs: z.array(z.string()).default(() => []),
        env: z.record(z.string(), z.string()).default(() => ({})),
        drainOnIdleMs: z.number().int().nonnegative().default(0),
      }),
    )
    .optional(),
  perf: z
    .object({
      traceRetentionDays: z.number().int().positive().optional(),
      taskRetentionDays: z.number().int().positive().default(7),
      slos: z.array(sloOverrideSchema).optional(),
      memoryAssemblyBudgets: memoryAssemblyBudgetsSchema.optional(),
      lazySkills: lazySkillsSchema.optional(),
      resumeSummaryBudget: resumeSummaryBudgetSchema.optional(),
      streaming: streamingConfigSchema.optional(),
      tools: toolsConfigSchema.optional(),
    })
    .optional(),
  // Phase 69: OpenAI-compatible endpoint config. DO NOT confuse with
  // mcpServers.openai (unrelated MCP entry at a different nesting level).
  openai: openaiEndpointSchema,
  // Phase 70: browser automation config (BROWSER-01..06). Governs the
  // resident Chromium singleton + per-agent BrowserContext persistence.
  browser: browserConfigSchema,
  // Phase 71: web search MCP config (SEARCH-01..03). Governs the Brave /
  // Exa provider clients + URL fetcher + Readability adapter. Backend
  // union locked at brave|exa; API keys read lazily at client call time.
  search: searchConfigSchema,
  // Phase 72: image generation MCP config (IMAGE-01..04). Governs the
  // OpenAI / MiniMax / fal.ai provider clients + workspace writer + cost
  // recorder. Backend union locked at openai|minimax|fal; API keys read
  // lazily at client call time. image_generate / edit / variations are
  // NOT idempotent (different images for same prompt) — explicitly
  // excluded from IDEMPOTENT_TOOL_DEFAULTS.
  image: imageConfigSchema,
  // Phase 116-06 T08 — operator-driven cutover redirect flag. When `true`,
  // the dashboard server responds with `301 Location: /dashboard/v2/`
  // for every `GET /`; when `false` (the default) the legacy static
  // index.html is served byte-identical to pre-Phase-116 behavior. The
  // flip is INTENTIONALLY manual (`clawcode config set
  // defaults.dashboardCutoverRedirect true`) so the operator owns the
  // moment of cutover. Reload classification: the dashboard handler
  // reads the live config ref on every request, so the flip takes
  // effect on the very next HTTP request after ConfigWatcher fires —
  // no daemon restart required.
  //
  // Operator rollback: `clawcode config set defaults.dashboardCutoverRedirect false`
  // returns the dashboard to dual-mode immediately. Old static files
  // remain on disk and untouched during the soak — see Phase 116-06
  // SUMMARY "Decommission follow-up" section for the post-soak cleanup
  // commit pattern.
  dashboardCutoverRedirect: z.boolean().default(false),
  /**
   * Phase 999.47 Plan 02 — homelab refresh tick configuration.
   *
   * See `homelabConfigSchema` below for the resolved shape. Optional —
   * pre-Phase-999.47 configs see no behaviour change at parse time;
   * the heartbeat check falls back to the documented defaults
   * (interval 60min, repoPath /home/clawcode/homelab) at consumption
   * time.
   */
  homelab: homelabConfigSchema.optional(),
  /**
   * Phase 101 Plan 02 T03 — document-ingestion pipeline knobs.
   *
   * All fields are reload-safe (NOT in NON_RELOADABLE_FIELDS). Defaults
   * mirror the values hard-coded in `src/document-ingest/` so existing
   * configs see no behaviour change at parse time.
   *
   * - `allowMistralOcr` (D-08) — off-by-default escape hatch. When `true`,
   *   `ingest_document --backend mistral` becomes selectable; otherwise
   *   the OCR dispatcher throws "Mistral OCR backend disabled in config".
   * - `tesseractConfidenceThreshold` (D-01) — minimum normalized confidence
   *   (0-1) for the Tesseract tier to short-circuit before falling through
   *   to Claude vision. Default 0.70 matches the locked plan value.
   * - `pageBatchSize` (U3) — greedy bin-packer page-count cap per batch.
   *   Matches `DEFAULT_BATCH_SIZE = 5` in `src/document-ingest/page-batch.ts`.
   * - `dimensionMaxPx` (T-101-04) — long-side resize ceiling for any image
   *   sent to Claude vision. Matches `DIMENSION_MAX_PX = 2000`.
   * - `visionModelDefault` / `visionModelHighPrecision` (D-02) — Claude
   *   vision model ids. Defaults match `claude-vision.ts`.
   */
  /**
   * Phase 999.154 — background image analysis for auto-ingest.
   * - `provider` — failover chain; `ocr-only` (no vision model) is always
   *   appended as the terminal entry by `resolveImageIngestConfig`.
   * - `batchSize` — labeled images per bridge spawn (measured: batching cuts
   *   per-image cost ~4x; the CLI's per-spawn overhead dominates).
   * - `canaryIntervalMin` — real-provider fixture check; 0 disables.
   * - `dedupe` — sha256 exact duplicates skip ingest; dHash near-duplicates
   *   (Hamming ≤ nearDupHamming) skip the vision call.
   * - `archive` — resized WebP copy kept `ttlDays` so images stay
   *   re-analyzable after the 24 h inbox retention.
   * Optional: omitted ⇒ IMAGE_INGEST_DEFAULTS (src/vision/config.ts).
   */
  imageIngest: z
    .object({
      provider: z.array(z.enum(["bridge-haiku", "ocr-only"])).min(1).optional(),
      batchSize: z.number().int().min(1).max(20).optional(),
      canaryIntervalMin: z.number().int().min(0).max(1440).optional(),
      dedupe: z
        .object({
          exact: z.boolean().optional(),
          nearDupHamming: z.number().int().min(0).max(32).optional(),
        })
        .optional(),
      archive: z
        .object({
          enabled: z.boolean().optional(),
          sidePx: z.number().int().min(512).max(4096).optional(),
          ttlDays: z.number().int().min(1).max(3650).optional(),
        })
        .optional(),
    })
    .optional(),
  documentIngest: z
    .object({
      allowMistralOcr: z.boolean().default(false),
      tesseractConfidenceThreshold: z.number().min(0).max(1).default(0.7),
      pageBatchSize: z.number().int().min(1).max(20).default(5),
      dimensionMaxPx: z.number().int().min(512).max(4096).default(2000),
      visionModelDefault: z.string().default("claude-haiku-4-5"),
      visionModelHighPrecision: z.string().default("claude-sonnet-5"),
      // Phase 101 Plan 04 (D-04, U9, SC-10) — local cross-encoder reranker
      // applied over Phase 90 RRF top-N. Hardcoded model id (T-101-13 — no
      // config-driven model selection); only the orchestration knobs are
      // exposed here. All four fields reloadable: `memory-retrieval.ts`
      // reads via a closure DI'd at daemon boot (mirrors the Phase 101
      // Plan 02 `setAllowMistralOcr` getter pattern).
      reranker: z
        .object({
          enabled: z.boolean().default(true),
          topNToRerank: z.number().int().min(1).max(100).default(20),
          finalTopK: z.number().int().min(1).max(20).default(5),
          timeoutMs: z.number().int().min(50).max(5000).default(500),
        })
        .default({
          enabled: true,
          topNToRerank: 20,
          finalTopK: 5,
          timeoutMs: 500,
        }),
      // Quick-260521-437 — per-turn retrieval tuning knobs that stop a
      // cross-ingested image/document dump from dominating every
      // subsequent turn's `<memory-context>` block. Both fields are
      // reload-safe (read at turn time by SessionManager.getMemoryRetriever
      // ForAgent via a call-time resolver closure — same pattern as the
      // reranker sub-object above) so an operator can tune them with
      // `clawcode reload` and no daemon bounce.
      retrieval: z
        .object({
          // How long a cross-ingested `document:`-prefixed chunk keeps its
          // 1.3x recency boost; shortened from a hardcoded 7d so a document
          // dump self-clears from per-turn retrieval in ~48h.
          recencyBoostDays: z.number().int().min(1).max(30).default(2),
          // Max `document:`-prefixed chunks admitted into a single pre-turn
          // retrieval, so a document dump cannot evict ALL conversational/
          // memory context.
          maxChunksPerRetrieval: z.number().int().min(1).max(20).default(2),
        })
        .default({ recencyBoostDays: 2, maxChunksPerRetrieval: 2 }),
    })
    .default({
      allowMistralOcr: false,
      tesseractConfidenceThreshold: 0.7,
      pageBatchSize: 5,
      dimensionMaxPx: 2000,
      visionModelDefault: "claude-haiku-4-5",
      visionModelHighPrecision: "claude-sonnet-5",
      reranker: {
        enabled: true,
        topNToRerank: 20,
        finalTopK: 5,
        timeoutMs: 500,
      },
      retrieval: {
        recencyBoostDays: 2,
        maxChunksPerRetrieval: 2,
      },
    })
    // `.optional()` after `.default(...)` mirrors the Phase 999.6
    // preDeploySnapshotMaxAgeHours / Phase 999.12 heartbeatInboxTimeoutMs
    // pattern — at the type level the field becomes optional so existing
    // DefaultsConfig test factories continue to compile without an explicit
    // entry; loader consumption uses `?? {...}` to materialize the baseline.
    .optional(),
});

// ---------------------------------------------------------------------------
// Phase 61 — Per-source trigger config schemas
// ---------------------------------------------------------------------------

/**
 * MySQL DB-change polling trigger config (TRIG-02).
 * Polls `SELECT ... WHERE id > ?` on a configurable table with committed-read
 * confirmation to avoid phantom triggers from ROLLBACKed inserts.
 */
export const mysqlTriggerSourceSchema = z.object({
  table: z.string().min(1),
  idColumn: z.string().min(1).default("id"),
  pollIntervalMs: z.number().int().positive().default(30_000),
  targetAgent: z.string().min(1),
  batchSize: z.number().int().positive().default(100),
  filter: z.string().optional(),
});
export type MysqlTriggerSourceConfig = z.infer<typeof mysqlTriggerSourceSchema>;

/**
 * Webhook HTTP trigger config (TRIG-03).
 * Accepts POST to `/webhook/<triggerId>` with HMAC-SHA256 signature verification.
 */
export const webhookTriggerSourceSchema = z.object({
  triggerId: z.string().min(1),
  secret: z.string().min(1),
  targetAgent: z.string().min(1),
  maxBodyBytes: z.number().int().positive().default(65_536),
});
export type WebhookTriggerSourceConfig = z.infer<typeof webhookTriggerSourceSchema>;

/**
 * Inbox filesystem trigger config (TRIG-04).
 * Watches collaboration inbox directory via chokidar with awaitWriteFinish.
 */
export const inboxTriggerSourceSchema = z.object({
  targetAgent: z.string().min(1),
  stabilityThresholdMs: z.number().int().min(0).default(500),
});
export type InboxTriggerSourceConfig = z.infer<typeof inboxTriggerSourceSchema>;

/**
 * Google Calendar polling trigger config (TRIG-05).
 * Polls upcoming events via MCP server and fires at configurable offsets.
 */
export const calendarTriggerSourceSchema = z.object({
  user: z.string().min(1),
  targetAgent: z.string().min(1),
  calendarId: z.string().min(1).default("primary"),
  pollIntervalMs: z.number().int().positive().default(300_000),
  offsetMs: z.number().int().min(0).default(900_000),
  maxResults: z.number().int().min(1).max(100).default(50),
  mcpServer: z.string().min(1),
  eventRetentionDays: z.number().int().positive().default(7),
});
export type CalendarTriggerSourceConfig = z.infer<typeof calendarTriggerSourceSchema>;

/**
 * Aggregate trigger sources config — optional object with arrays for each
 * source type. Each array defaults to empty (source type disabled).
 */
export const triggerSourcesConfigSchema = z.object({
  mysql: z.array(mysqlTriggerSourceSchema).default([]),
  webhook: z.array(webhookTriggerSourceSchema).default([]),
  inbox: z.array(inboxTriggerSourceSchema).default([]),
  calendar: z.array(calendarTriggerSourceSchema).default([]),
}).optional();
export type TriggerSourcesConfig = z.infer<typeof triggerSourcesConfigSchema>;

/**
 * Phase 60 — trigger engine configuration section.
 *
 * Lives at root level in clawcode.yaml under `triggers`. Optional — when
 * omitted, TriggerEngine uses the defaults from types.ts
 * (DEFAULT_REPLAY_MAX_AGE_MS, DEFAULT_DEBOUNCE_MS).
 *
 * Phase 61 extends this with an optional `sources` sub-object containing
 * per-source-type config arrays.
 */
export const triggersConfigSchema = z.object({
  replayMaxAgeMs: z.number().int().positive().default(86400000),
  defaultDebounceMs: z.number().int().min(0).default(5000),
  sources: triggerSourcesConfigSchema,
}).optional();

/** Inferred triggers config type. */
export type TriggersConfig = z.infer<typeof triggersConfigSchema>;

/**
 * Table-rendering mode for outbound Discord text (2026-06-22).
 *
 *   - `adaptive` (default) — narrow tables → re-padded aligned grid in a
 *     code fence; wide tables → stacked cards; 2-column → key/value pairs.
 *   - `cards` — always stacked cards (maximally mobile, more verbose).
 *   - `fence` — legacy: wrap the raw table in a ```text``` fence, no
 *     re-padding (the pre-2026-06-22 behavior; rollback path).
 *   - `off` — no table transformation at all.
 *
 * See `src/discord/markdown-table-wrap.ts`. Daemon-wide; applied at boot via
 * `configureTableRendering` (non-reloadable — restart to change).
 */
export const tableRenderingConfigSchema = z.object({
  mode: z.enum(["adaptive", "cards", "fence", "off"]).default("adaptive"),
  // Max aligned-monospace width (chars, incl. ` | ` separators) before a
  // table converts to cards. Models a phone's code-block width; biased
  // toward cards. Default 32 calibrated against a real iPhone (2026-06-25).
  mobileColumnBudget: z.number().int().positive().default(32),
  // 2026-08-27 — wide numeric grids (adaptive mode) render as PNG cards
  // attached to the message; see src/discord/table-delivery.ts. Boot-only.
  image: z.object({
    enabled: z.boolean().default(true),
    minColumns: z.number().int().min(2).default(3),
    maxRows: z.number().int().positive().default(40),
    maxCellChars: z.number().int().positive().default(80),
    scale: z.number().min(1).max(3).default(2),
  }).optional(),
}).optional();
export type TableRenderingConfig = z.infer<typeof tableRenderingConfigSchema>;

/**
 * Schema for optional Discord configuration.
 * botToken can be a literal token or an op:// reference resolved via 1Password CLI.
 */
export const discordConfigSchema = z.object({
  botToken: z.string().min(1).optional(),
  tableRendering: tableRenderingConfigSchema,
  // 2026-08-28 — SUPPRESS_EMBEDS on every agent delivery (no link preview
  // cards under replies). Boot-only. See src/discord/delivery-flags.ts.
  suppressLinkEmbeds: z.boolean().default(true),
  /**
   * Phase 999.144 — HUMAN ingress allowlist: Discord user ids (snowflakes)
   * whose messages may dispatch agent turns. Unset = feature off (any human
   * in a bound channel dispatches, the pre-999.144 behavior). `.min(1)`
   * makes "configured but empty" unrepresentable — an empty list would
   * silently brick every channel including the operator's own. Guild
   * membership and channel permissions remain the outer walls; this is the
   * inner one, so a compromised/added account still cannot drive the fleet.
   * Boot-applied (bridge captures it at wiring time).
   */
  allowedUserIds: z.array(z.string().regex(/^\d{5,25}$/)).min(1).optional(),
}).optional();

/** Discord config type. */
export type DiscordConfig = z.infer<typeof discordConfigSchema>;

/**
 * Schema for optional Slack configuration (multi-platform messaging phase).
 *
 * Slack uses ONE workspace app for the whole fleet — per-agent identity is
 * achieved per-message via `username`/`icon_url` (see agent.slack), so no
 * per-agent token is needed (unlike Telegram). Both tokens may be literals or
 * op:// references resolved via 1Password CLI.
 *   - appToken (xapp-…): app-level token for Socket Mode (WebSocket inbound).
 *   - botToken (xoxb-…): bot token for the Web API (outbound).
 * Socket Mode needs no public endpoint, so this works behind Tailscale.
 */
export const slackConfigSchema = z
  .object({
    appToken: z.string().min(1),
    botToken: z.string().min(1),
  })
  .optional();

/** Slack config type. */
export type SlackConfig = z.infer<typeof slackConfigSchema>;

/**
 * Root config schema for clawcode.yaml.
 * Requires version: 1 and at least one agent.
 */
export const configSchema = z.object({
  version: z.literal(1),
  discord: discordConfigSchema,
  slack: slackConfigSchema,
  defaults: defaultsSchema.default(() => ({
    model: "haiku" as const,
    effort: "low" as const,
    // Phase 86 MODEL-01 — fleet-wide allowlist default matches the full
    // modelSchema enum so configs that omit `defaults` see identical
    // behavior to v2.1 (all three model aliases pickable).
    // Phase 999.114 — was ["haiku","sonnet","opus"]. The picker default is now
    // the full catalog (see DEFAULT_PICKER_MODELS) so every tier and every
    // historical pin is selectable from Discord. Mutable copy: this is a zod
    // default factory value and the schema type is a mutable array.
    allowedModels: [...DEFAULT_PICKER_MODELS] as ConfigModel[],
    // Phase 89 GREET-07 / GREET-10 — fleet-wide defaults mirroring the
    // zod-populated values in defaultsSchema above.
    greetOnRestart: true,
    greetCoolDownMs: 300_000,
    // Phase 90 MEM-01 — fleet-wide default mirrors the zod-populated value.
    memoryAutoLoad: true,
    // Phase 90 MEM-02 / MEM-03 — fleet-wide defaults mirror the zod-populated
    // values in defaultsSchema above. Scanner on by default; retrieval
    // topK=5 + token budget 2000 per D-RETRIEVAL.
    memoryRetrievalTopK: 5,
    // Phase 999.124 — recall footer on by default.
    memoryRecallFooter: true,
    // Phase 115 sub-scope 3 — was 2000 (pre-115 dead-knob default). Now
    // 1500 (CONTEXT.md D-02). Mirror exists for the configSchema fallback
    // when `defaults:` is OMITTED entirely from clawcode.yaml.
    memoryRetrievalTokenBudget: 1500,
    // Phase 115 sub-scope 4 — locked default tag-exclusion list mirrors
    // defaultsSchema's zod default. Mutable copy so the configSchema-level
    // record is independent of the array literal.
    memoryRetrievalExcludeTags: ["session-summary", "mid-session", "raw-fallback"],
    // Phase 115 sub-scope 2 — fleet-wide default mirrors defaultsSchema.
    excludeDynamicSections: true,
    // Phase 115 sub-scope 5 (Plan 04) — fleet-wide default mirrors
    // defaultsSchema. "static-first" places static sections before the
    // CACHE_BREAKPOINT_MARKER and dynamic sections after; "legacy"
    // preserves pre-115-04 interleaved order with no marker (revert path).
    cacheBreakpointPlacement: "static-first" as const,
    memoryScannerEnabled: true,
    // Phase 127 — fleet-wide stream-stall supervisor default mirrors
    // defaultsSchema.streamStallTimeoutMs above (180000ms / 3 min). Per-model
    // overrides (Opus 300000 / Haiku 90000) are operator-set; this literal
    // applies only when `defaults:` is OMITTED entirely from clawcode.yaml.
    streamStallTimeoutMs: 180_000,
    // Phase 999.99 — fleet-wide SDK deny-list default mirrors defaultsSchema
    // above (blocks the leaky ScheduleWakeup/CronCreate self-fire tools;
    // Monitor steered-not-blocked per Q3). This literal applies only when
    // `defaults:` is OMITTED entirely from clawcode.yaml.
    // Phase 145 WS3 — "AskUserQuestion" kept in sync with the defaultsSchema
    // `.default([...])` floor above (the non-rendering built-in, replaced by
    // the MCP ask_user_question tool in Plan 04).
    disallowedTools: ["ScheduleWakeup", "CronCreate", "AskUserQuestion"],
    // Phase 90 MEM-04 / MEM-05 — fleet-wide defaults mirror defaultsSchema.
    memoryFlushIntervalMs: 900_000,
    memoryCueEmoji: "✅",
    // Phase 999.43 D-09 — fleet-wide defaults mirror defaultsSchema above.
    // Default false preserves back-compat: existing v2.x configs (no
    // `defaults:` block at all) see auto-ingest OFF for every agent.
    autoIngestAttachments: false,
    ingestionPriority: "medium" as const,
    // Phase 132 D-03 / D-08 — fleet-wide defaults mirror defaultsSchema
    // above. Default false preserves back-compat: existing v2.x configs
    // (no `defaults:` block at all) see autonomous skill drafting OFF
    // for every agent. Threshold literals (5 / 180_000 / ["success"])
    // mirror the zod-populated defaults — kept in sync manually with the
    // `defaultsSchema.skillDistiller` block above (same pattern as
    // autoIngestAttachments / ingestionPriority).
    // Phase 999.42 capability B (CONTEXT D4) — minToolCalls lowered
    // 6→5 for Hermes parity; minDurationMs + outcomeFilter unchanged
    // from Phase 132 D-03. Phase 999.42 capability C (CONTEXT D7) —
    // suggestPatches added, default false (gates the patch-suggest path).
    autonomousSkillDrafting: false,
    skillDistiller: {
      minToolCalls: 5,
      minDurationMs: 180_000,
      outcomeFilter: ["success"] as ("success" | "partial" | "failed")[],
      suggestPatches: false,
    },
    // Phase 100 follow-up — fleet-wide autoStart default mirrors the
    // zod-populated value in defaultsSchema above. Default true preserves
    // back-compat: every configured agent boots on daemon start-all unless
    // it (or the operator's defaults block) explicitly opts out.
    autoStart: true,
    // Phase 94 TOOL-10 / D-10 — fleet-wide default directives mirror
    // DEFAULT_SYSTEM_PROMPT_DIRECTIVES (D-09 file-sharing + D-07 cross-
    // agent-routing). Spread to a fresh object so the configSchema-default
    // record is independent of the frozen exported constant (defensive
    // copy — downstream merges via resolveSystemPromptDirectives never
    // see the frozen reference).
    systemPromptDirectives: { ...DEFAULT_SYSTEM_PROMPT_DIRECTIVES },
    // Phase 95 DREAM-01..03 — fleet-wide default dream cycle config
    // mirrors the zod-populated value in defaultsSchema above.
    dream: { enabled: false, idleMinutes: 30, model: "haiku" as const },
    // Phase 96 D-05 — fleet-wide default fileAccess paths mirror the
    // zod-populated value in defaultsSchema above. Spread to a fresh
    // array so the configSchema-default is independent of the frozen
    // exported constant (defensive copy — downstream merges via
    // resolveFileAccess never see the frozen reference).
    fileAccess: [...DEFAULT_FILE_ACCESS],
    // Phase 96 D-09 — fleet-wide default outputDir mirrors the zod-populated
    // value in defaultsSchema above. Tokens preserved literally; runtime
    // resolveOutputDir expands them per call.
    outputDir: DEFAULT_OUTPUT_DIR,
    // Phase 90 Plan 04 HUB-01 / HUB-08 — ClawHub registry defaults
    // mirroring the zod-populated values in defaultsSchema above.
    clawhubBaseUrl: "https://clawhub.ai",
    clawhubCacheTtlMs: 600_000,
    skills: [] as string[],
    basePath: "~/.clawcode/agents",
    skillsPath: "~/.clawcode/skills",
    memory: { compactionThreshold: 0.75, searchTopK: 10, consolidation: { enabled: true, weeklyThreshold: 4, monthlyThreshold: 4, schedule: "0 3 * * *" }, decay: { halfLifeDays: 30, semanticWeight: 0.7, decayWeight: 0.3 }, deduplication: { enabled: true, similarityThreshold: 0.85 }, tiers: { hotAccessThreshold: 3, hotAccessWindowDays: 7, hotDemotionDays: 7, coldRelevanceThreshold: 0.05, hotBudget: 20, centralityPromoteThreshold: 5 }, episodes: { archivalAgeDays: 90 } },
    heartbeat: {
      enabled: true,
      intervalSeconds: 60,
      checkTimeoutSeconds: 10,
      contextFill: { warningThreshold: 0.6, criticalThreshold: 0.75, zoneThresholds: { yellow: 0.50, orange: 0.70, red: 0.85 } },
    },
    threads: {
      idleTimeoutMinutes: 1440,
      // Phase 99 sub-scope N (2026-04-26) — lowered from 10 to 3.
      maxThreadSessions: 3,
    },
    // Phase 69 — OpenAI-compatible endpoint defaults (OPENAI-01..07).
    openai: {
      enabled: true,
      port: 3101,
      host: "0.0.0.0",
      maxRequestBodyBytes: 10485760, // CAM-01/02 — 10 MiB (vision turns)
      streamKeepaliveMs: 15000,
    },
    // Phase 70 — browser automation defaults (BROWSER-01..06).
    browser: {
      enabled: true,
      headless: true,
      warmOnBoot: true,
      navigationTimeoutMs: 30000,
      actionTimeoutMs: 10000,
      viewport: { width: 1280, height: 720 },
      userAgent: null,
      maxScreenshotInlineBytes: 524288,
    },
    // Phase 71 — web search MCP defaults (SEARCH-01..03).
    search: {
      enabled: true,
      backend: "brave" as const,
      brave: {
        apiKeyEnv: "BRAVE_API_KEY",
        safeSearch: "moderate" as const,
        country: "us",
      },
      exa: {
        apiKeyEnv: "EXA_API_KEY",
        useAutoprompt: false,
      },
      maxResults: 20,
      timeoutMs: 10000,
      fetch: {
        timeoutMs: 30000,
        maxBytes: 1048576,
        userAgentSuffix: null,
      },
    },
    // Phase 72 — image generation MCP defaults (IMAGE-01..04).
    image: {
      enabled: true,
      backend: "openai" as const,
      openai: { apiKeyEnv: "OPENAI_API_KEY", model: "gpt-image-1" },
      minimax: { apiKeyEnv: "MINIMAX_API_KEY", model: "image-01" },
      fal: { apiKeyEnv: "FAL_API_KEY", model: "fal-ai/flux-pro" },
      maxImageBytes: 10485760,
      timeoutMs: 60000,
      workspaceSubdir: "generated-images",
    },
    // Phase 116-06 T08 — cutover flag default mirror. FALSE preserves the
    // current dual-mode behavior (both `/` and `/dashboard/v2/` reachable);
    // operator flips to TRUE manually via `clawcode config set`.
    dashboardCutoverRedirect: false,
    // Phase 124 Plan 02 D-06 — fleet-wide auto-compaction trigger ratio
    // mirror for the configSchema-default-when-`defaults`-omitted fallback.
    "auto-compact-at": 0.7,
    // Phase 101 Plan 02 T03 — fleet-wide document-ingestion defaults mirror
    // for the configSchema-default-when-`defaults`-omitted fallback.
    // Defaults mirror the values hard-coded in `src/document-ingest/`.
    documentIngest: {
      allowMistralOcr: false,
      tesseractConfidenceThreshold: 0.7,
      pageBatchSize: 5,
      dimensionMaxPx: 2000,
      visionModelDefault: "claude-haiku-4-5",
      visionModelHighPrecision: "claude-sonnet-5",
      // Phase 101 Plan 04 — reranker defaults mirror for the `defaults:`-omitted
      // fallback. Operator override via per-agent or fleet-wide config.
      reranker: {
        enabled: true,
        topNToRerank: 20,
        finalTopK: 5,
        timeoutMs: 500,
      },
      // Quick-260521-437 — retrieval-tuning defaults mirror for the
      // `defaults:`-omitted fallback. Operator override via fleet-wide config.
      retrieval: {
        recencyBoostDays: 2,
        maxChunksPerRetrieval: 2,
      },
    },
  })),
  mcpServers: z.record(z.string(), mcpServerSchema).default({}),
  triggers: triggersConfigSchema,
  agents: z.array(agentSchema).min(1),
}).superRefine((cfg, ctx) => {
  // Phase 75 SHARED-01 — detect two agents declaring the SAME memoryPath.
  // Raw-string comparison is sufficient at this layer: loader.ts handles
  // expansion + path resolution; identical user-facing YAML values are
  // guaranteed to collide post-expansion. Path-normalization edge cases
  // (trailing slash, ./ prefixes) are explicitly out of scope per the
  // deferred section of 75-CONTEXT.md and are handled downstream.
  const byPath = new Map<string, string[]>();
  for (const agent of cfg.agents) {
    if (!agent.memoryPath) continue;
    const list = byPath.get(agent.memoryPath) ?? [];
    list.push(agent.name);
    byPath.set(agent.memoryPath, list);
  }
  for (const [path, names] of byPath) {
    if (names.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents"],
        message: `memoryPath conflict: "${path}" is declared by multiple agents (${names.join(", ")}). Each agent must have a distinct memoryPath or omit it to fall back to workspace.`,
      });
    }
  }

  // Phase 78 CONF-01 — mutual exclusion: inline `soul`/`identity` cannot
  // coexist with file-pointer `soulFile`/`identityFile` on the same agent.
  // Ambiguous precedence would silently prefer one over the other; we fail
  // loud at load time instead. Per-agent scope (cross-agent mix is fine).
  for (const agent of cfg.agents) {
    if (agent.soul !== undefined && agent.soulFile !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents"],
        message: `agent "${agent.name}": inline "soul" and "soulFile" cannot be used together — pick one (soulFile is preferred for migrated agents).`,
      });
    }
    if (agent.identity !== undefined && agent.identityFile !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents"],
        message: `agent "${agent.name}": inline "identity" and "identityFile" cannot be used together — pick one (identityFile is preferred for migrated agents).`,
      });
    }
  }

  // Quick 260715-j1j (D7) — `effort: ultracode` is an orchestration-mode
  // opt-in, not just a thinking budget: it requires the SAME agent to carry
  // `nativeWorkflow: true` (which unblocks the native Workflow tool the mode
  // orchestrates through). Fail loud at load time (matches the soul/soulFile
  // mutex pattern above) instead of shipping an agent whose ultracode mode
  // can never activate. Lives on configSchema — NOT agentSchema.superRefine —
  // because daemon.ts's patch-agent IPC calls `agentSchema.partial()` at
  // runtime and a ZodEffects wrapper has no `.partial`. Model capability is
  // deliberately NOT checked here (model may be an alias); the runtime gate
  // (ultracode-gate.ts) owns capability.
  for (const agent of cfg.agents) {
    if (agent.effort === "ultracode" && agent.nativeWorkflow !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agents"],
        message: `agent "${agent.name}": effort: ultracode requires nativeWorkflow: true on the same agent (ultracode orchestrates via the native Workflow tool, which stays fleet-blocked without the opt-in).`,
      });
    }
  }

  // Phase 999.13 DELEG-03 — every delegates value must point to a known agent.
  // Fail fast at config load (matches the soul/soulFile mutex pattern above)
  // so operators don't ship a half-booted fleet with a broken delegate target.
  const agentNames = new Set(cfg.agents.map((a) => a.name));
  for (const agent of cfg.agents) {
    if (!agent.delegates) continue;
    for (const [specialty, target] of Object.entries(agent.delegates)) {
      if (!agentNames.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["agents"],
          message: `agent "${agent.name}": delegates["${specialty}"] points to unknown agent "${target}". Configure that agent or remove this delegate entry.`,
        });
      }
    }
  }
});

/** Fully parsed and validated config. */
export type Config = z.infer<typeof configSchema>;

/** Raw agent entry before defaults merging. */
export type AgentConfig = z.infer<typeof agentSchema>;

/** Top-level defaults section. */
export type DefaultsConfig = z.infer<typeof defaultsSchema>;

/**
 * Phase 88 MKT-02 — one raw marketplace source entry as it appears in
 * clawcode.yaml `defaults.marketplaceSources`. `path` is the yaml-native
 * string (possibly `~/...`); expansion happens in loader.ts via
 * `resolveMarketplaceSources`. `label` is the optional human-readable
 * caption shown in the Discord picker.
 */
export type MarketplaceSourceConfig = NonNullable<
  DefaultsConfig["marketplaceSources"]
>[number];
