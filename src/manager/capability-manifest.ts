import type { ResolvedAgentConfig } from "../shared/types.js";
import { buildAgentAwarenessBlock } from "../advisor/prompts.js";
import { resolveAdvisorBackend } from "../config/loader.js";

// Phase 117 Plan 08 — advisor awareness defaults.
// Capability-manifest hint for the per-agent daily budget. The live
// throttle is enforced by `AdvisorBudget` at IPC dispatch time; this is
// the prompt-time hint so the agent has a rough sense of remaining
// headroom. Future work: thread the operator-tunable value through here.
// (Plan 117-04 wires the runtime budget; surface here is informational.)
const ADVISOR_DAILY_BUDGET_HINT = 10;

/**
 * Phase 100 follow-up — capability manifest builder.
 *
 * Problem (operator surface 2026-04-27): fin-client was asked
 * "what have you dreamed about recently?" and answered "I don't dream —
 * no downtime between sessions." This was false: fin had `dream.enabled:
 * true` in clawcode.yaml and dreams persisted to memory/dreams/YYYY-MM-DD.md.
 * The agent literally didn't know its own features were on.
 *
 * Fix: emit a compact "Your ClawCode Capabilities" markdown block at
 * session-prompt assembly time so the LLM has the enabled feature list
 * in context. Pure read of ResolvedAgentConfig — no I/O, no
 * hallucination, no bloat for minimal agents.
 *
 * Placement: after identity, before the mutable suffix (so it sits in
 * the cached stable prefix and is cache-friendly across turns).
 *
 * Returns the markdown block as a string. When the agent has zero notable
 * opted-in features (a baseline agent with only memoryAutoLoad) the
 * capability header and bullets are skipped and only the memory protocol
 * is returned (memory overhaul 2026-10-25, WP5: every agent needs it).
 *
 * Tier 1 fields (Phase 100-fu, 2026-04-26):
 *   - MCP servers       — list with operator-curated description+accessPattern
 *   - Skills            — comma-separated skill names
 *   - Model + effort    — model={model}, effort={effort}
 *   - Conversation memory — single sentence about session-summary auto-resume
 *
 * Tier 2 fields (Phase 100-fu, 2026-04-26):
 *   - File access       — fileAccess paths if present
 *   - Heartbeat         — "{every} {model}" or "disabled"
 *   - Subagent recursion guard — single sentence about SDK-level disallowedTools
 *   - autoRelay/autoArchive defaults — note about subagent_thread defaults
 *
 * Each bullet uses ONLY values from the resolved config — no
 * speculation. If a feature is disabled/undefined, the bullet is omitted
 * entirely (rather than printed empty) to keep prompts tight.
 *
 * Render order (alphabetical-by-section is NOT desired — operator-set
 * order favors the most behavior-shaping fields first):
 *   1. Memory dreaming
 *   2. Scheduled tasks
 *   3. Subagent threads (with auto-relay note)
 *   4. MCP servers
 *   5. Skills
 *   6. Memory system (GSD if present)
 *   7. File access
 *   8. Model + effort
 *   9. Heartbeat
 *  10. Conversation memory
 *  11. Recursion guard
 */
export function buildCapabilityManifest(
  config: ResolvedAgentConfig,
  // Phase 999.173 — research-enabled agents get the "only when asked"
  // workflow bullet; every other agent's manifest is byte-identical.
  opts: Readonly<{ researchSubagents?: boolean }> = {},
): string {
  const bullets: string[] = [];

  // ---- 1. Memory dreaming ----
  // Only when explicitly enabled. Pulls idleMinutes + model verbatim from
  // resolved config so the LLM tells the operator the actual cadence.
  if (config.dream?.enabled === true) {
    const idle = config.dream.idleMinutes;
    const model = config.dream.model;
    bullets.push(
      `- **Memory dreaming**: auto-fires every ${idle}min idle, model=${model}; persists to memory/dreams/YYYY-MM-DD.md; manual trigger via /clawcode-dream slash command (admin-only).`,
    );
  }

  // ---- 2. Scheduled tasks ----
  if (config.schedules.length > 0) {
    const count = config.schedules.length;
    bullets.push(
      `- **Scheduled tasks**: ${count} cron schedule${count === 1 ? "" : "s"} wired (see /clawcode-schedule slash command for the list).`,
    );
  }

  // ---- 3. Subagent threads (with autoRelay/autoArchive note) ----
  // Gated on the skill assignment to keep parity with session-config.
  if (config.skills.includes("subagent-thread")) {
    bullets.push(
      "- **Subagent threads**: spawn_subagent_thread MCP tool ready. Defaults: `autoRelay: true` for non-delegated spawns (first reply is summarized to your channel); `autoRelay: false` when `delegateTo` is set (Phase 999.57 — the delegate must call `subagent_complete` to relay its final answer, because multi-turn delegated work can't be summarized from turn 1). Pass `autoArchive: true` for fire-and-forget on non-delegated spawns.",
    );
  }

  // ---- 4. MCP servers ----
  // Render: "name (description — pattern), name (description), name"
  // Skip empty mcpServers list and skip auto-injected entries that lack
  // operator-curated annotations? No — render everything, but bare names
  // without description fall back to just the name (no parens).
  //
  // Phase 100 follow-up — when the agent has an mcpEnvOverrides entry for
  // the server's OP_SERVICE_ACCOUNT_TOKEN env key, append a `vault-scoped`
  // annotation. This signals to the LLM that the 1Password access surface
  // is NARROWER than the daemon's clawdbot full-fleet token. Without this,
  // the agent confidently asserts cross-vault reads it cannot perform
  // (the same failure mode that motivated the manifest in the first place
  // — an agent not knowing its own opted-in features).
  if (config.mcpServers.length > 0) {
    const items = config.mcpServers.map((s) => {
      const envOverride = config.mcpEnvOverrides?.[s.name];
      const isVaultScoped =
        envOverride?.OP_SERVICE_ACCOUNT_TOKEN !== undefined;
      const baseAnnotation = (() => {
        if (!s.description && !s.accessPattern) return null;
        if (s.description && s.accessPattern) {
          return `${s.description} — ${s.accessPattern}`;
        }
        return s.description ?? s.accessPattern ?? null;
      })();
      const vaultNote = isVaultScoped ? "vault-scoped" : null;
      const parts = [baseAnnotation, vaultNote].filter(
        (p): p is string => typeof p === "string" && p.length > 0,
      );
      if (parts.length === 0) return s.name;
      return `${s.name} (${parts.join(" — ")})`;
    });
    bullets.push(`- **MCP servers**: ${items.join(", ")}.`);
  }

  // ---- 5. Skills ----
  // Comma-separated names; skip when empty.
  if (config.skills.length > 0) {
    bullets.push(`- **Skills**: ${config.skills.join(", ")}.`);
  }

  // ---- 6. GSD workflow ----
  if (config.gsd?.projectDir !== undefined) {
    bullets.push(
      `- **GSD workflow**: gsd.projectDir=${config.gsd.projectDir}; /gsd-* slash commands available.`,
    );
  }

  // ---- 7. File access ----
  // Render the configured paths. Operator-set fileAccess paths matter for
  // the LLM to know which areas it can read/write without burning tool
  // calls on probe-fs.
  if (config.fileAccess && config.fileAccess.length > 0) {
    bullets.push(
      `- **File access**: ${config.fileAccess.join(", ")}.`,
    );
  }

  // ---- 8. Model + effort ----
  // Always rendered when manifest is non-empty (cheap, helps the LLM know
  // its own runtime knobs — useful for "why are you slow" type questions).
  bullets.push(
    `- **Model + effort**: model=${config.model}, effort=${config.effort}.`,
  );

  // ---- 9. Heartbeat ----
  // When the agent has the extended `heartbeat: { every, model }` shape,
  // surface those operator-set values verbatim. Otherwise show "disabled"
  // when the heartbeat is off, or skip entirely (the agent's default
  // intervalSeconds-based heartbeat is internal — not behavior-shaping
  // for the LLM).
  if (config.heartbeat.enabled === false) {
    bullets.push("- **Heartbeat**: disabled.");
  } else if (config.heartbeat.every && config.heartbeat.model) {
    bullets.push(
      `- **Heartbeat**: ${config.heartbeat.every} ${config.heartbeat.model}.`,
    );
  }
  // If heartbeat.enabled but no per-agent every/model, omit the bullet —
  // the global intervalSeconds default isn't useful prompt content.

  // ---- 10. Conversation memory ----
  // Always rendered when manifest is non-empty. This is the fix for the
  // root-cause failure: agents not knowing their own session-resume
  // capability and saying "I don't remember our last conversation".
  bullets.push(
    "- **Conversation memory**: Prior session summaries auto-resume on session start (Phase 64). Working memory of recent turns preserved across daemon restarts.",
  );

  // ---- 10a. Lazy-load memory tools (Phase 115 sub-scope 7) ----
  // Always rendered alongside conversation memory: the four lazy-load
  // memory tools are exposed to every agent unless explicitly disallowed.
  // The bullet lists them; the longer Memory protocol section below
  // teaches the agent WHEN to call each.
  bullets.push(
    "- **Lazy memory recall**: `clawcode_memory_search` (FTS5+vec hybrid), `clawcode_memory_recall` (full body by id), `clawcode_memory_edit` (str_replace / append on MEMORY.md / USER.md), `clawcode_memory_archive` (promote a chunk into Tier 1), `clawcode_memory_update` / `clawcode_memory_forget` (correct or retire a saved memory).",
  );

  // ---- 10b. Advisor awareness (Phase 117 Plan 08) ----
  // Inject the advisor bullet when the resolved backend is "native" or
  // "fork" (always true given the resolver's default of "native"; the
  // explicit gate guards future operators who disable advisor entirely).
  // The prose protocol is appended at the very end of the manifest (after
  // memoryProtocol) so it lands in the cached stable prefix alongside
  // the other protocol blocks. (RESEARCH §4.3.)
  //
  // EXPLICIT DO-NOT: `src/manager/capability-probes.ts` is MCP server
  // liveness probes (browser/1password) — it is NOT the capability
  // declaration registry and must not be touched here. (RESEARCH §6
  // Pitfall 5.)
  const advisorBackend = resolveAdvisorBackend(
    config as { advisor?: { backend?: string } } | undefined,
    undefined,
  );
  const advisorAwareness =
    advisorBackend === "native" || advisorBackend === "fork"
      ? buildAgentAwarenessBlock({
          backend: advisorBackend,
          dailyBudget: ADVISOR_DAILY_BUDGET_HINT,
        })
      : null;
  if (advisorAwareness !== null) {
    bullets.push(advisorAwareness.bullet);
  }

  // ---- 11. Recursion guard ----
  // Only rendered when the agent has the subagent-thread skill — the
  // guard is informational about how the SDK enforces "subagents cannot
  // spawn subagents", and is moot for agents that can't spawn subagents
  // in the first place. Gating it also keeps prompts of non-subagent
  // agents free of `spawn_subagent_thread` references (parity with
  // session-config.ts subagent-thread guidance gate).
  if (config.skills.includes("subagent-thread")) {
    bullets.push(
      "- **Subagent recursion guard**: If you are a subagent (sessionName ends with `-sub-XXXXXX` or `-via-<delegate>-XXXXXX`), the `spawn_subagent_thread` MCP tool is disabled at SDK level — recursion is impossible by design (Phase 99-N).",
    );
  }

  // ---- 12. Background workflows (start_workflow) ----
  // Gated on the clawcode MCP server (where start_workflow lives). Teaches the
  // agent that a daemon-side, Discord-VISIBLE, stall-recovered alternative to
  // the in-session harness Workflow tool exists — when to use it, its
  // parallel-only limit, and the REAL `/clawcode-workflows` status command (so
  // it stops suggesting the CLI-only `/workflows` that does nothing in Discord).
  if (config.mcpServers.some((s) => s.name === "clawcode") && opts.researchSubagents === true) {
    bullets.push(
      "- **Background workflows (`start_workflow`)**: Use ONLY when the user explicitly asks for a workflow — research and deep dives go to `researcher` subagents instead. It runs up to 8 INDEPENDENT tasks in parallel as a background job that returns immediately and posts progress + results to your channel, is PARALLEL-ONLY (no pipelines), and a stuck step is auto-aborted after ~15 min. Tell users to check progress with `/clawcode-workflows` in Discord — NEVER `/workflows`, which is a CLI-only command that does nothing in Discord.",
    );
  } else if (config.mcpServers.some((s) => s.name === "clawcode")) {
    bullets.push(
      "- **Background workflows (`start_workflow`)**: Run up to 8 INDEPENDENT tasks in parallel as a background job that returns immediately and posts progress + results to your channel. Prefer it over the in-session workflow tool for background fan-out — its progress IS visible in Discord (via `/clawcode-workflows`) and a stuck step is auto-aborted after ~15 min so it can't hang (the in-session tool is neither visible nor recoverable). It is PARALLEL-ONLY — no pipelines/dependencies; do any verification or synthesis yourself in a follow-up turn once the parallel results return. Tell users to check progress with `/clawcode-workflows` in Discord — NEVER `/workflows`, which is a CLI-only command that does nothing in Discord.",
    );
  }

  // Memory overhaul 2026-10-25 (WP5) - the memory protocol is the only
  // place the agent is told how and when to read and write memory, so it
  // is emitted for EVERY agent, including baseline agents that get no
  // capability bullets (see `buildMemoryProtocol`).
  const memoryProtocol = buildMemoryProtocol(config);

  // Bail out cleanly when the agent has zero notable opt-ins. We test
  // this against the SAME criteria as before Phase 100-fu (dream /
  // schedules / subagent-thread skill / GSD), because Tier 1+2 fields
  // (model+effort, conversation memory, recursion guard) are
  // unconditional once any opt-in feature is present. A baseline agent
  // (no dream, no schedules, no skill, no GSD, no fileAccess, no MCP
  // servers beyond auto-injected ones) gets only the memory protocol.
  const hasOptIn =
    config.dream?.enabled === true ||
    config.schedules.length > 0 ||
    config.skills.includes("subagent-thread") ||
    config.gsd?.projectDir !== undefined ||
    (config.fileAccess !== undefined && config.fileAccess.length > 0) ||
    config.mcpServers.length > 0 ||
    config.skills.length > 0;

  if (!hasOptIn) return memoryProtocol.trimStart();

  const header =
    "## Your ClawCode Capabilities\n\nYou are running on ClawCode — a multi-agent orchestration system. The following features are CURRENTLY ENABLED for you (do NOT claim ignorance about these):\n\n";

  // Phase 117 Plan 08 — append the Advisor protocol prose alongside the
  // memory protocol so both land in the cached stable prefix. When the
  // advisor is gated off (future "none" backend), advisorProtocol is "".
  // Awareness is also conditionally tied to having ANY notable opt-in
  // (matches the file-level rule "don't bloat minimal agents" — those
  // agents already get an empty manifest above; if a minimal agent has
  // somehow reached this point, the advisor bullet was already pushed
  // alongside the other bullets and the protocol naturally rides along).
  const advisorProtocol =
    advisorAwareness !== null ? advisorAwareness.protocol : "";

  return header + bullets.join("\n") + "\n" + memoryProtocol + advisorProtocol;
}

/**
 * Memory overhaul 2026-10-25 (WP5) - the memory protocol section.
 *
 * Teaches the agent which tool answers which question (saved memories and
 * memory files vs uploaded documents), to save durable facts with
 * absolute dates, to correct instead of re-saving, and that MEMORY.md is a
 * short curated index, not a dumping ground. The "loaded into this prompt"
 * and "retrieved before each turn" sentences follow the resolved config,
 * so a subagent with memoryAutoLoad=false or memoryRetrievalTopK=0 is not
 * told it was given memory it was not given.
 *
 * Starts with a newline and ends with one, so it can follow the bullet
 * list or stand alone.
 */
export function buildMemoryProtocol(config: ResolvedAgentConfig): string {
  const autoLoaded = config.memoryAutoLoad !== false;
  const retrievedPerTurn = (config.memoryRetrievalTopK ?? 0) > 0;

  const indexLine = autoLoaded
    ? "- MEMORY.md and USER.md are your short, curated index (standing facts, preferences, pointers), loaded into this prompt at session start. Keep them short: edit them with `clawcode_memory_edit` (str_replace / append) and never paste long notes or transcripts into them. Edits show in the prompt from the next session."
    : "- MEMORY.md and USER.md are your short, curated index (standing facts, preferences, pointers). They are NOT loaded into this session: read them with `clawcode_memory_edit` (mode view) when you need them, and keep them short.";
  const recallLine = retrievedPerTurn
    ? "- A few relevant memories are retrieved for you before each turn. For anything older or more specific, call `clawcode_memory_search` before assuming you remember or don't: it searches your saved memories and your memory files (daily notes, digests, MEMORY.md) across all time. Fetch a full hit with `clawcode_memory_recall(memoryId)`."
    : "- Nothing is retrieved for you automatically in this session. Call `clawcode_memory_search` before assuming you remember or don't: it searches your saved memories and your memory files (daily notes, digests, MEMORY.md) across all time. Fetch a full hit with `clawcode_memory_recall(memoryId)`.";

  return (
    "\n## Memory protocol\n\n" +
    indexLine +
    "\n" +
    recallLine +
    "\n" +
    "- Files the user uploaded or that were ingested as documents (PDFs, spreadsheets, images) are searched with `search_documents`, not the memory tools.\n" +
    "- Save a durable fact with `memory_save`: one fact per call, written with absolute dates (YYYY-MM-DD, never \"today\" or \"next week\"). The result says whether it was created, already stored (duplicate), or superseded an older similar memory.\n" +
    "- When a saved memory is wrong or out of date, fix it with `clawcode_memory_update(id, content)`; when it no longer applies, retire it with `clawcode_memory_forget(id, reason)`. Do not save a second, conflicting copy. Search hits carry dates: when two disagree, trust the newer one.\n" +
    "- Promote a memory file section you found into MEMORY.md with `clawcode_memory_archive(chunkId)` only when it belongs in the curated index.\n"
  );
}
