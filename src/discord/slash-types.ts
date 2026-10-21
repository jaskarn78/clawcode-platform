/**
 * Slash command type definitions and default commands for Discord integration.
 *
 * These types define the data contract for slash commands that agents
 * can register and handle via Discord's application command system.
 */

/**
 * A single option for a slash command.
 *
 * The `type` field uses Discord's ApplicationCommandOptionType numeric values:
 * - 1 = SUB_COMMAND
 * - 2 = SUB_COMMAND_GROUP
 * - 3 = STRING
 * - 4 = INTEGER
 * - 5 = BOOLEAN
 * - 6 = USER
 * - 7 = CHANNEL
 * - 8 = ROLE
 * - 9 = MENTIONABLE
 * - 10 = NUMBER (double)
 * - 11 = ATTACHMENT
 */
export type SlashCommandOption = {
  readonly name: string;
  readonly type: number;
  readonly description: string;
  readonly required: boolean;
  /**
   * Phase 83 UI-01 — Discord native structured choices for STRING options
   * (type 3). When present, Discord renders a dropdown of the provided values
   * and refuses free-text input. Each choice: `{ name: <display>, value: <sent-to-handler> }`.
   *
   * Discord hard-caps this at 25 entries per option (zod-enforced at
   * slashCommandOptionSchema). Omit the field entirely for free-text options
   * (existing /clawcode-memory, /clawcode-model, control-command agent args).
   */
  readonly choices?: readonly { readonly name: string; readonly value: string }[];
};

/**
 * 999.105 — canonical style picker for `/clawcode-style`.
 *
 * LITERAL list by module convention: slash-types.ts is deliberately
 * import-free (EFFORT_CHOICES below is the precedent — synced to its schema
 * by a TEST, not an import). The drift guard lives in
 * __tests__/slash-types-style-choices.test.ts: every roster id must appear
 * here and vice versa. `status` is a pseudo-choice the handler renders as a
 * state report instead of a set. Discord caps choices at 25; this is 13.
 */
export const STYLE_CHOICES = [
  { name: "default - clear override, agent's natural form",        value: "default" },
  { name: "bluf - answer first, detail after",                     value: "bluf" },
  { name: "brief - fewest words that carry the information",       value: "brief" },
  { name: "bluf-brief - answer first, then only what carries info",  value: "bluf-brief" },
  { name: "proportional - answer first; shape follows content",       value: "proportional" },
  { name: "ledger - bold answer line; one figure or fact per line; ### parts", value: "ledger" },
  { name: "smart-brevity - Axios: lead / Why it matters / Go deeper", value: "smart-brevity" },
  { name: "steps - action-first numbered steps",                   value: "steps" },
  { name: "plain - short sentences, no jargon (STE)",              value: "plain" },
  { name: "explanatory - answers plus a short Insight",            value: "explanatory" },
  { name: "sourced - every claim carries number, source, date",    value: "sourced" },
  { name: "proactive - acts on stated defaults, asks less",        value: "proactive" },
  { name: "status - show current styles",                          value: "status" },
];

/**
 * Phase 83 UI-01 — canonical EffortLevel picker for `/clawcode-effort`.
 *
 * Eight entries, one per level in the v2.2 effortSchema. Order matches the
 * schema's z.enum tuple (low → max) with auto and off tail-positioned because
 * they're semantically distinct from the graded scale (auto = model default,
 * off = explicit disable via setMaxThinkingTokens(0)).
 *
 * Quick 260715-j1j (D12) — `ultracode` appended LAST (matches the schema
 * tuple): xhigh budget + native-Workflow orchestration mode. Gated at
 * SessionManager.setEffortForAgent — only an xhigh-capable (opus/fable)
 * agent with `nativeWorkflow: true` may select it; everyone else gets the
 * gate's rejection reason as the ephemeral reply.
 *
 * Wired into DEFAULT_SLASH_COMMANDS.clawcode-effort.options[0].choices below
 * AND forwarded by slash-commands.ts:register() into the Discord REST body so
 * the user sees a dropdown, not a text box.
 */
export const EFFORT_CHOICES = [
  { name: "low (fastest)",        value: "low"    },
  { name: "medium",               value: "medium" },
  { name: "high",                 value: "high"   },
  { name: "xhigh",                value: "xhigh"  },
  { name: "max (deepest)",        value: "max"    },
  { name: "auto (model default)", value: "auto"   },
  { name: "off (disabled)",       value: "off"    },
  // Review IN-02 — "xhigh", not "max": mapEffortToTokens(ultracode) = 24576
  // (the xhigh budget); consistent with the status-render label.
  { name: "ultracode (xhigh + workflows)", value: "ultracode" },
] as const;

/**
 * Definition of a single slash command.
 *
 * `claudeCommand` is the prompt sent to the agent when the command is invoked.
 * Placeholders like `{query}` are replaced with the corresponding option value.
 */
export type SlashCommandDef = {
  readonly name: string;
  readonly description: string;
  readonly claudeCommand: string;
  readonly options: readonly SlashCommandOption[];
  readonly control?: boolean;
  readonly ipcMethod?: string;
  /**
   * Phase 87 CMD-01 — dispatch discriminator for native Claude Code commands.
   *
   *   - "control-plane"   → dispatch via SDK Query.setX() (model/permissions/
   *                          effort); zero LLM turn cost
   *   - "prompt-channel"  → send as user text through TurnDispatcher
   *                          (compact / context / cost / help / hooks / ...)
   *
   * Absent on the CONTROL_COMMANDS (daemon-routed IPC) and on the remaining
   * DEFAULT_SLASH_COMMANDS (static LLM-prompt commands). Plans 02/03 route
   * entirely on the presence of this field — no name-matching required.
   */
  readonly nativeBehavior?: "control-plane" | "prompt-channel";
  /**
   * Phase 100 follow-up — Discord `default_member_permissions` bitmask
   * (passed verbatim to the REST registration body). Set `"0"` to hide
   * the command from every non-admin user in the guild; only members
   * with the `ADMINISTRATOR` role bit (or guild owner) see it in the
   * slash menu. Combine with the handler-level channel guard at
   * slash-commands.ts:1443 for defense in depth.
   *
   * Discord's per-channel command permissions (the "Integrations →
   * Bot → /command → Channels" UI override) cannot be set by the bot
   * itself — that endpoint requires a user OAuth token. Operators
   * apply per-channel restrictions manually post-deploy (see
   * SMOKE-TEST.md Section 8.5 hardening note).
   *
   * Spec: https://discord.com/developers/docs/interactions/application-commands#permissions
   */
  readonly defaultMemberPermissions?: string;
  /**
   * Phase 999.21 — when set, the registration loop nests this entry under
   * the named top-level command as a SUB_COMMAND (Discord type=1) instead
   * of registering it as a standalone slash command. Internal dispatch
   * (handleInteraction) rewrites `<top-level>+<sub>` back to the legacy
   * flat name (`gsd-${sub}`) on entry so existing carve-outs
   * (handleSetGsdProjectCommand, GSD_LONG_RUNNERS, the agent-routed
   * branch) keep working unchanged. This collapses the 19 flat `gsd-*`
   * entries into a single `/get-shit-done` top-level command on Discord —
   * reclaiming 18 slots in Discord's per-guild 100-command cap and giving
   * operators a self-organizing namespace in the slash menu.
   */
  readonly subcommandOf?: string;
  /**
   * Skill-slash-commands — dispatch discriminator for opt-in per-skill
   * commands. When set, the command was registered for a skill whose
   * SKILL.md frontmatter has `slashCommand: true`. `skillName` is the
   * ORIGINAL (un-normalised) skill name — the handler uses it both for the
   * channel-agent skill-membership gate and to substitute into the
   * `claudeCommand` natural-language template.
   *
   * Absent on every static command (DEFAULT_SLASH_COMMANDS, CONTROL_COMMANDS,
   * GSD_SLASH_COMMANDS, native-CC entries). The handleInteraction carve-out
   * routes entirely on the presence of this field.
   */
  readonly skillDispatch?: { readonly skillName: string };
};

// Phase 87 CMD-04 — clawcode-compact + clawcode-usage REMOVED from
// DEFAULT_SLASH_COMMANDS. They are re-provided by the SDK registration loop
// in slash-commands.ts via native-cc-commands.buildNativeCommandDefs as
// native-dispatch entries (nativeBehavior:"prompt-channel"). The native
// path is the ONLY path for /compact and /cost going forward.

/**
 * Default slash commands available to all agents.
 * Agents can override or extend these via clawcode.yaml config.
 */
export const DEFAULT_SLASH_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: "clawcode-status",
    description: "Get the agent's current status",
    claudeCommand: `Report your status in EXACTLY this compact format (replace values with your actual state). Use emoji line prefixes. Keep it concise — no extra text:

🤖 {your name} · {model}
🧮 Tokens: {input tokens} in / {output tokens} out
📚 Context: {estimate}% used · 🧹 Compactions: {count}
🧵 Session: {your session id or "active"} • updated {when}
⚙️ Runtime: SDK session · Permissions: bypass
💰 Usage: {tokens in} in / {tokens out} out · \${cost} this session
📋 Task: {what you're currently doing or "idle"}`,
    options: [],
  },
  {
    name: "clawcode-memory",
    description: "Search the agent's memory",
    claudeCommand: "Search your memory for: {query}",
    options: [
      {
        name: "query",
        type: 3,
        description: "What to search for",
        required: true,
      },
    ],
  },
  {
    name: "clawcode-schedule",
    description: "Show the agent's scheduled tasks",
    claudeCommand: "Show your current scheduled tasks and their next run times",
    options: [],
  },
  {
    name: "clawcode-health",
    description: "Get the agent's health status",
    claudeCommand: "Report your health status including context usage and memory stats",
    options: [],
  },
  {
    name: "clawcode-model",
    description: "Change the agent's model (opens a picker when no model is specified)",
    // Phase 86 MODEL-02 / MODEL-03 — LLM-prompt routing REMOVED. The inline
    // handler in slash-commands.ts owns both the no-arg (picker) and arg
    // (IPC dispatch) paths. claudeCommand is intentionally empty so any
    // accidental fallback to formatCommandMessage emits a no-op string that
    // the inline short-circuit prevents from ever being sent.
    claudeCommand: "",
    options: [
      {
        name: "model",
        type: 3,
        description: "Model alias (optional — omit to open picker)",
        required: false,
      },
      // 2026-09-04 — optional `agent` target, mirroring /clawcode-effort and
      // /clawcode-style. Until now this was the ONLY per-agent mutator without
      // one, so a model change could only be made from the target agent's own
      // channel. NOT a regression of the 2026-08-07 native-clobber (that cost
      // /clawcode-effort its `agent` option and /clawcode-model its picker);
      // this option simply never existed.
      //
      // The option MUST be named exactly "agent" lowercase with NO static
      // choices, or the fleet-dropdown injection in slash-commands.ts
      // (`opt.name === "agent" && canPickAgent`) silently skips it.
      {
        name: "agent",
        type: 3,
        description: "Target agent (optional — defaults to this channel's agent)",
        required: false,
      },
    ],
  },
  {
    // 999.105 — per-agent output style. Mirrors /clawcode-effort: admin-only
    // visibility, admin-clawdy channel guard in the handler, optional `agent`
    // target. The option MUST be named exactly "agent" lowercase with NO
    // static choices, or the fleet-dropdown injection at
    // slash-commands.ts:1869 silently dies. `status` is a CHOICE VALUE, not a
    // subcommand — subcommandOf entries are collected and never registered.
    name: "clawcode-style",
    // 2026-08-14 operator decision — NOT admin-gated (unlike /clawcode-effort):
    // style is cosmetic per-agent formatting with no cost dimension, so any
    // user may set it from any channel. In an agent's channel it applies to
    // that channel's bound agent; `agent:` still allows explicit targeting.
    description: "Set this channel agent's output style (bluf, brief, ...)",
    claudeCommand: "__style__{style}",
    options: [
      {
        name: "style",
        type: 3,
        description: "Output style (applies next turn, no restart)",
        required: true,
        choices: STYLE_CHOICES,
      },
      {
        name: "agent",
        type: 3,
        description: "Target agent name (default: admin-clawdy)",
        required: false,
      },
    ],
  },
  {
    name: "clawcode-effort",
    description: "Set reasoning effort level (admin-clawdy only)",
    claudeCommand: "__effort__{level}",
    // Phase 100 follow-up — `"0"` hides the command from every non-admin
    // user. Only the guild owner / admins see it. Even then, the handler
    // at slash-commands.ts:1443 rejects invocation outside #admin-clawdy.
    // Truly per-channel hiding (so even the owner doesn't see it outside
    // #admin-clawdy) requires the operator to set channel overrides
    // manually in Discord's Server Settings UI — bots can't push that.
    defaultMemberPermissions: "0",
    options: [
      {
        name: "level",
        type: 3,
        description: "Effort level for Claude's next turn",
        required: true,
        // Phase 83 UI-01 — forces Discord to render a 7-item dropdown instead
        // of a free-text input. No invalid level can be typed.
        choices: EFFORT_CHOICES,
      },
      // Phase 100 follow-up — optional target agent. When provided, applies
      // the effort to that agent (validated against sessionManager.getAgentConfig).
      // When omitted, applies to the channel-bound agent — which under the
      // admin-clawdy channel guard at slash-commands.ts:1443 is admin-clawdy
      // itself. Free-text by design: the choices list would have to enumerate
      // every configured agent statically and stay in sync via codegen, which
      // is heavier than just typing the name.
      {
        name: "agent",
        type: 3,
        description: "Target agent name (default: admin-clawdy)",
        required: false,
      },
    ],
  },
  {
    name: "clawcode-skills",
    description: "List installed skills for this agent (with remove option)",
    // Phase 88 MKT-07 / UI-01 — inline handler renders the installed list +
    // native StringSelectMenuBuilder remove picker, dispatches
    // IPC marketplace-remove on selection.
    claudeCommand: "",
    options: [],
  },

  // Phase 999.31 — top-level shortcuts to native Anthropic Claude Code
  // commands. Not GSD-flavored; standalone slash entries that the agent's
  // session resolves directly via settingSources (~/.claude/CLAUDE.md +
  // built-in command set). claudeCommand is forwarded verbatim so the SDK
  // sees the native /ultraplan / /ultrareview invocation.
  {
    name: "ultra-plan",
    description: "Deep multi-agent planning (native Anthropic /ultraplan)",
    claudeCommand: "/ultraplan {args}",
    options: [
      { name: "args", type: 3, description: "Task description", required: true },
    ],
  },
  {
    name: "ultra-review",
    description: "Multi-agent cloud review of current branch (or specific PR)",
    claudeCommand: "/ultrareview {args}",
    options: [
      { name: "args", type: 3, description: "Optional PR number", required: false },
    ],
  },

  // Phase 999.32 — single-entry GSD command. Replaces the /get-shit-done
  // composite (Phase 999.21) which had 19 subcommand slots cluttering the
  // Discord menu. Operator types the gsd subcommand name + flags as a
  // single string; the dispatcher in slash-commands.ts parses the first
  // token, rewrites commandName to `gsd-${first-token}` so existing
  // carve-outs (GSD_LONG_RUNNERS subagent-thread spawn for autonomous /
  // plan-phase / execute-phase, set-project inline handler) keep working
  // unchanged.
  //
  // Examples:
  //   /gsd-do args:autonomous --from 100      → fires /gsd:autonomous --from 100
  //   /gsd-do args:plan-phase 109             → fires /gsd:plan-phase 109
  //   /gsd-do args:set-project /opt/projects  → inline runtime project switch
  //   /gsd-do args:debug "memory leak"        → fires /gsd:debug "memory leak"
  {
    name: "gsd-do",
    description: "Run a GSD command. Args: <subcommand> [flags...] (e.g. autonomous --from 100)",
    claudeCommand: "/gsd:{args}",
    options: [
      { name: "args", type: 3, description: "GSD subcommand + flags", required: true },
    ],
  },
  // Phase 135 Plan 01 Task 3 — /vc {join,leave,status} voice channel
  // commands. Single top-level slash command with three SUB_COMMAND
  // (type=1) entries; mirrors the discord.js subcommand pattern in
  // /get-shit-done. Plan 01 ships PLACEHOLDER handlers (handleVcCommand
  // in src/discord/voice/command.ts) — every branch returns a "Phase 135
  // Plan 02 will wire this" string. Plan 02 substitutes the real
  // VoiceManager.join/leave wiring without touching the slash-command
  // registration shape.
  //
  // `join` carries a `channel:CHANNEL` nested option (type=7) so
  // operators pick the target voice channel from Discord's native
  // channel picker. Plan 02 reads it via
  // `interaction.options.getChannel("channel", true)`.
  //
  // `ipcMethod: "vc"` routes through the inline-handler short-circuit in
  // slash-commands.ts (BEFORE the generic CONTROL_COMMANDS branch). The
  // ACL check intentionally lives at the handler boundary (Plan 03), not
  // at the registration boundary — `defaultMemberPermissions` is
  // undefined so the command is visible to all guild members and the
  // handler enforces the per-account allowlist via voice/access.ts.
  {
    name: "vc",
    description: "Voice channel controls (join / leave / status)",
    claudeCommand: "",
    ipcMethod: "vc",
    options: [
      {
        name: "join",
        type: 1, // SUB_COMMAND
        description: "Join a voice channel",
        required: false,
      },
      {
        name: "leave",
        type: 1,
        description: "Leave the current voice channel",
        required: false,
      },
      {
        name: "status",
        type: 1,
        description: "Show active voice sessions",
        required: false,
      },
    ],
  },
] as const;

/**
 * Phase 100 follow-up — auto-inherited slash commands for any agent with
 * `gsd.projectDir` configured. Operator-curated subset of the ~57 GSD skills
 * in ~/.claude/commands/gsd/ — covers the most common paths so operators
 * don't hit "command not found" friction in the Discord slash menu. The full
 * 57 remain available via plain-text /gsd:* typing.
 *
 * Auto-injected at register time (slash-commands.ts register loop) when at
 * least one agent has `gsd?.projectDir` set. Per-agent yaml entries with
 * matching names get deduped via the existing `seenNames` set so the legacy
 * Phase 100 yaml block on Admin Clawdy keeps working unchanged.
 *
 * Phase 999.21 — entries are now NESTED subcommands under a single top-level
 * `/get-shit-done` command (each entry has `subcommandOf: "get-shit-done"`).
 * The slash-commands.ts register loop groups every entry whose `subcommandOf`
 * matches into ONE composite Discord body item (type=1 SUB_COMMAND children),
 * collapsing 19 flat `gsd-*` slots into 1 namespaced slot. The handleInteraction
 * dispatcher rewrites `commandName === "get-shit-done"` + `getSubcommand()`
 * back to the legacy flat form (`gsd-${sub}`) at the top of the function so
 * every downstream carve-out keeps matching by the legacy strings unchanged.
 *
 * Dispatch (post-rewrite, all carve-outs see the legacy `gsd-*` names):
 *   - `/get-shit-done autonomous`, `/get-shit-done plan-phase`,
 *     `/get-shit-done execute-phase` route to handleGsdLongRunner (subagent
 *     thread spawn) when GSD_LONG_RUNNERS matches the rewritten name.
 *   - `/get-shit-done set-project` is handled inline by handleSetGsdProjectCommand
 *     (validates path + dispatches IPC `set-gsd-project`); claudeCommand
 *     intentionally empty so any accidental fallback to formatCommandMessage
 *     emits a no-op string the inline short-circuit prevents from being sent.
 *   - All other entries fall through to the legacy agent-routed branch where
 *     formatCommandMessage rewrites their claudeCommand template into the
 *     canonical SDK form for inline dispatch via the user's settingSources
 *     (loads ~/.claude/commands/gsd/*.md per Plan 100-06 symlinks).
 *
 * The `name` field on each entry is the SUBCOMMAND name (e.g. "autonomous",
 * "plan-phase", "set-project") — NOT the full flat name. The composite
 * top-level command is named `"get-shit-done"`.
 */
export const GSD_SLASH_COMMANDS: readonly SlashCommandDef[] = [
  // The 5 originally shipped in Phase 100 Plan 04 (also live in Admin Clawdy's
  // yaml block — dedup via seenNames keeps both registrations safe).
  {
    name: "autonomous",
    subcommandOf: "get-shit-done",
    description: "Run all remaining phases autonomously",
    claudeCommand: "/gsd:autonomous {args}",
    options: [
      { name: "args", type: 3, description: "Optional flags (e.g. --from 100)", required: false },
    ],
  },
  {
    name: "plan-phase",
    subcommandOf: "get-shit-done",
    description: "Create phase plan with verification loop",
    claudeCommand: "/gsd:plan-phase {phase}",
    options: [
      { name: "phase", type: 3, description: "Phase number + optional flags", required: false },
    ],
  },
  {
    name: "execute-phase",
    subcommandOf: "get-shit-done",
    description: "Execute all plans in a phase",
    claudeCommand: "/gsd:execute-phase {phase}",
    options: [
      { name: "phase", type: 3, description: "Phase number + optional flags", required: false },
    ],
  },
  {
    name: "debug",
    subcommandOf: "get-shit-done",
    description: "Systematic debugging with persistent state",
    claudeCommand: "/gsd:debug {issue}",
    options: [
      { name: "issue", type: 3, description: "Issue description", required: true },
    ],
  },
  {
    name: "quick",
    subcommandOf: "get-shit-done",
    description: "Quick task with GSD guarantees",
    claudeCommand: "/gsd:quick {task}",
    options: [
      { name: "task", type: 3, description: "Task description", required: true },
    ],
  },

  // Phase 100 follow-up additions — operator hit friction (these were missing
  // from the slash menu, forcing them to type /gsd:* manually).
  {
    name: "new-project",
    subcommandOf: "get-shit-done",
    description: "Initialize a fresh GSD project (PROJECT.md, REQUIREMENTS.md, ROADMAP.md, codebase maps)",
    claudeCommand: "/gsd:new-project {args}",
    options: [
      { name: "args", type: 3, description: "Optional project description", required: false },
    ],
  },
  {
    name: "new-milestone",
    subcommandOf: "get-shit-done",
    description: "Create a new milestone in the current project",
    claudeCommand: "/gsd:new-milestone {args}",
    options: [
      { name: "args", type: 3, description: "Milestone description", required: false },
    ],
  },
  {
    name: "add-phase",
    subcommandOf: "get-shit-done",
    description: "Insert a new phase into the current milestone",
    claudeCommand: "/gsd:add-phase {args}",
    options: [
      { name: "args", type: 3, description: "Phase description", required: false },
    ],
  },
  {
    name: "add-tests",
    subcommandOf: "get-shit-done",
    description: "Add tests for an existing phase or plan",
    claudeCommand: "/gsd:add-tests {args}",
    options: [
      { name: "args", type: 3, description: "Target (phase/plan id)", required: false },
    ],
  },
  {
    name: "audit-milestone",
    subcommandOf: "get-shit-done",
    description: "Audit milestone before completion",
    claudeCommand: "/gsd:audit-milestone",
    options: [],
  },
  {
    name: "complete-milestone",
    subcommandOf: "get-shit-done",
    description: "Mark current milestone complete + archive",
    claudeCommand: "/gsd:complete-milestone {args}",
    options: [
      { name: "args", type: 3, description: "Milestone version", required: false },
    ],
  },
  {
    name: "cleanup",
    subcommandOf: "get-shit-done",
    description: "Clean up planning artifacts after milestone",
    claudeCommand: "/gsd:cleanup",
    options: [],
  },
  {
    name: "progress",
    subcommandOf: "get-shit-done",
    description: "Show current GSD project progress",
    claudeCommand: "/gsd:progress",
    options: [],
  },
  {
    name: "verify-work",
    subcommandOf: "get-shit-done",
    description: "Manually verify a phase or UAT item",
    claudeCommand: "/gsd:verify-work {args}",
    options: [
      { name: "args", type: 3, description: "Phase/UAT id", required: false },
    ],
  },
  {
    name: "discuss-phase",
    subcommandOf: "get-shit-done",
    description: "Discuss design grey areas before planning",
    claudeCommand: "/gsd:discuss-phase {phase}",
    options: [
      { name: "phase", type: 3, description: "Phase number", required: true },
    ],
  },
  {
    name: "do",
    subcommandOf: "get-shit-done",
    description: "Quick task wrapper with GSD guarantees",
    claudeCommand: "/gsd:do {task}",
    options: [
      { name: "task", type: 3, description: "Task description", required: true },
    ],
  },
  {
    name: "fast",
    subcommandOf: "get-shit-done",
    description: "Lightweight GSD without full ceremony",
    claudeCommand: "/gsd:fast {task}",
    options: [
      { name: "task", type: 3, description: "Task description", required: true },
    ],
  },
  {
    name: "help",
    subcommandOf: "get-shit-done",
    description: "GSD framework help",
    claudeCommand: "/gsd:help {args}",
    options: [
      { name: "args", type: 3, description: "Command name (optional)", required: false },
    ],
  },

  // The runtime project switcher — handled inline (not routed to LLM).
  // claudeCommand "" mirrors /clawcode-model and /clawcode-skills-browse.
  {
    name: "set-project",
    subcommandOf: "get-shit-done",
    description: "Switch this agent's gsd.projectDir at runtime (avoids yaml edit + restart)",
    claudeCommand: "",
    options: [
      { name: "path", type: 3, description: "Absolute path to the new project directory", required: true },
    ],
  },

] as const;

/**
 * Control commands that route directly to the daemon via IPC.
 * These bypass agent sessions entirely — the daemon handles start/stop/restart/status.
 */
export const CONTROL_COMMANDS: readonly SlashCommandDef[] = [
  {
    name: "clawcode-start",
    description: "Start an agent",
    claudeCommand: "",
    control: true,
    ipcMethod: "start",
    options: [
      { name: "agent", type: 3, description: "Agent name to start", required: true },
    ],
  },
  {
    name: "clawcode-stop",
    description: "Stop an agent",
    claudeCommand: "",
    control: true,
    ipcMethod: "stop",
    options: [
      { name: "agent", type: 3, description: "Agent name to stop", required: true },
    ],
  },
  {
    name: "clawcode-restart",
    description: "Restart an agent",
    claudeCommand: "",
    control: true,
    ipcMethod: "restart",
    options: [
      { name: "agent", type: 3, description: "Agent name to restart", required: true },
    ],
  },
  {
    name: "clawcode-fleet",
    description: "Show fleet status",
    claudeCommand: "",
    control: true,
    ipcMethod: "status",
    options: [],
  },
  {
    name: "clawcode-workflows",
    description: "Background workflows: status, or cancel/steer one (admin)",
    claudeCommand: "",
    control: true,
    ipcMethod: "workflow-status",
    options: [
      {
        name: "agent",
        type: 3,
        description: "Filter by triggering agent (default: all)",
        required: false,
      },
      // Phase 999.165 — act on one workflow. Cancel is admin-gated in the
      // handler (this command itself is not admin-only).
      {
        name: "workflow",
        type: 3,
        description: "Workflow id (wf_…) to act on",
        required: false,
      },
      {
        name: "action",
        type: 3,
        description: "What to do with that workflow",
        required: false,
        choices: [
          { name: "status", value: "status" },
          { name: "cancel (admin)", value: "cancel" },
          { name: "steer (admin) — text is the new direction", value: "steer" },
        ],
      },
      {
        name: "step",
        type: 3,
        description: "Only this step (its stepId)",
        required: false,
      },
      {
        name: "text",
        type: 3,
        description: "Cancel: the reason. Steer: the new direction.",
        required: false,
      },
    ],
  },
  // Quick task 260419-nic — live control over an agent's in-flight SDK turn.
  // /clawcode-interrupt aborts the current turn (drops the queue slot).
  // /clawcode-steer aborts + dispatches a [USER STEER] follow-up so the
  // agent course-corrects without waiting for the current turn to finish.
  // Names deliberately avoid collision with the existing clawcode-stop
  // (which stops a whole agent, not a turn).
  {
    name: "clawcode-interrupt",
    description: "Abort the agent's in-flight turn (no effect if idle)",
    claudeCommand: "",
    control: true,
    ipcMethod: "interrupt-agent",
    options: [
      { name: "agent", type: 3, description: "Agent name (default: channel's agent)", required: false },
    ],
  },
  {
    name: "clawcode-steer",
    description: "Abort current turn and redirect the agent with new guidance",
    claudeCommand: "",
    control: true,
    ipcMethod: "steer-agent",
    options: [
      { name: "guidance", type: 3, description: "What the agent should do instead", required: true },
      { name: "agent", type: 3, description: "Agent name (default: channel's agent)", required: false },
    ],
  },
  // /clawcode-goal — autonomous "run until the condition is met" loop on the
  // channel's agent, duplicating Claude Code's /goal. Inline-handled (the
  // condition/action options pick goal-set / goal-status / goal-clear), so the
  // nominal `ipcMethod` below is never used by the generic control dispatch.
  {
    name: "clawcode-goal",
    description: "Run the agent autonomously until a goal condition is met (like Claude Code /goal)",
    claudeCommand: "",
    control: true,
    ipcMethod: "goal-set",
    options: [
      {
        name: "condition",
        type: 3,
        description:
          "The goal to pursue. Add limits inline, e.g. '…or stop after 20 turns / 2 hours'. Omit to see status.",
        required: false,
      },
      {
        name: "action",
        type: 3,
        description: "set (default when a condition is given) · status · clear",
        required: false,
      },
      { name: "agent", type: 3, description: "Agent name (default: this channel's agent)", required: false },
    ],
  },
  // Phase 85 Plan 03 TOOL-06 / UI-01 — daemon-routed MCP readiness view.
  // Reads the per-agent state map populated by Plan 01's warm-path gate +
  // mcp-reconnect heartbeat (ipcMethod "list-mcp-status"). The inline handler
  // in slash-commands.ts renders the reply as a native Discord EmbedBuilder
  // (UI-01 compliance — NOT free-text). Zero LLM turn cost per invocation.
  {
    name: "clawcode-tools",
    description: "Show MCP tool status and refresh live for the bound agent",
    claudeCommand: "",
    control: true,
    ipcMethod: "list-mcp-status",
    options: [
      {
        name: "agent",
        type: 3,
        description: "Agent name (defaults to the channel's bound agent)",
        required: false,
      },
    ],
  },
  // Phase 95 Plan 03 DREAM-07 / UI-01 — operator-driven manual dream-pass
  // trigger. Admin-only ephemeral; the inline-short-circuit handler in
  // slash-commands.ts checks isAdminClawdyInteraction BEFORE routing through
  // ipcMethod "run-dream-pass" so non-admins get an instant "Admin-only
  // command" reply (zero IPC + zero LLM turn cost). Renders the
  // DreamPassOutcome via renderDreamEmbed (themedReflection + counts +
  // cost + log path). 10th application of the inline-short-circuit pattern.
  {
    name: "clawcode-dream",
    description:
      "Dream pass: run one, list pending promotions, or veto/approve a run (999.188)",
    claudeCommand: "",
    control: true,
    ipcMethod: "run-dream-pass",
    options: [
      {
        name: "agent",
        type: 3,
        description: "Agent name (default: this channel's agent)",
        required: false,
      },
      {
        name: "action",
        type: 3,
        description: "run (default) · pending · veto · approve",
        required: false,
        choices: [
          { name: "run", value: "run" },
          { name: "pending", value: "pending" },
          { name: "veto", value: "veto" },
          { name: "approve", value: "approve" },
        ],
      },
      { name: "run", type: 3, description: "Run id (for veto / approve)", required: false },
      { name: "reason", type: 3, description: "Why (for veto)", required: false },
    ],
  },
  // Phase 999.176 — fleet Claude subscription account swap (admin-only, Admin
  // Clawdy channel + admin user id). Inline handler (account-swap-flow.ts):
  // status → preflight → (re-login via Mac agent ‖ pasted code) → confirm →
  // restart; the swap applies at the next boot. The inline handler talks to
  // the in-process AccountService; ipcMethod names the read-only status call
  // so the generic path (never reached) could only ever read.
  {
    name: "clawcode-account",
    description: "Show or switch the fleet's Claude subscription account (admin-only; restarts the fleet)",
    claudeCommand: "",
    control: true,
    ipcMethod: "account-status",
    options: [],
    defaultMemberPermissions: "0",
  },
  // Phase 142 — measured agent optimizer trigger (admin-only). Stages skill
  // proposals (add/revise/remove) for operator review with a baseline→candidate
  // delta; never auto-applies.
  {
    name: "clawcode-optimize",
    description:
      "Run the measured agent optimizer for an agent (admin-only; stages skill proposals for review)",
    claudeCommand: "",
    control: true,
    ipcMethod: "run-agent-optimization",
    options: [
      {
        name: "agent",
        type: 3,
        description: "Agent name to optimize",
        required: true,
      },
    ],
  },
  // Phase 999.32 — `clawcode-probe-fs` slash command removed (operator
  // cleanup). The IPC handler `probe-fs` and the `clawcode probe fs <agent>`
  // CLI subcommand both stay live for programmatic / scripted re-probe;
  // the heartbeat fs-probe still runs every 60s for ambient refresh.
  // Operators who need an explicit re-probe can run the CLI directly.
  // Phase 103 OBS-07 / UI-01 — daemon-routed OAuth Max usage panel. Reads
  // the per-agent RateLimitTracker via ipcMethod "list-rate-limit-snapshots"
  // (NOT "rate-limit-status" which is the SEPARATE Discord outbound rate-
  // limiter IPC at protocol.ts:17 — see Pitfall 5). The inline handler in
  // slash-commands.ts renders an EmbedBuilder (UI-01 compliance — NOT free-
  // text). Zero LLM turn cost per invocation. 12th application of the
  // inline-handler-short-circuit-before-CONTROL_COMMANDS pattern (Phases
  // 85/86/87/88/90/91/92/95/96/100).
  {
    name: "clawcode-usage",
    description: "Show OAuth Max session/weekly usage for the bound agent",
    claudeCommand: "",
    control: true,
    ipcMethod: "list-rate-limit-snapshots",
    options: [
      {
        name: "agent",
        type: 3,
        description: "Agent name (defaults to the channel's bound agent)",
        required: false,
      },
    ],
  },
  // Phase 117 Plan 117-11 — operator-facing per-channel verbose toggle for
  // advisor visibility (the 💭 footer vs the fenced advice block driven by
  // the bridge mutation point seeded in 117-09 at bridge.ts:~810).
  //
  //   /clawcode-verbose level:on     → fenced advice block (≤500 chars)
  //   /clawcode-verbose level:off    → plain footer + 💭 reaction only
  //   /clawcode-verbose level:status → reports current level + ISO timestamp
  //
  // Admin-only (defaultMemberPermissions:"0" — Phase 100 admin precedent +
  // RESEARCH §7 Q3). All replies ephemeral; channel-state only (no per-agent
  // override — RESEARCH §13.2 + 117-CONTEXT.md deferred). Choice label says
  // "advice" (not "Q+A") per RESEARCH §13.2 correction — the executor never
  // passes a question; `server_tool_use.input` is always `{}`.
  // 999.63d/7 — operator-facing verification trail control. Mirrors the
  // Phase 117 /clawcode-verbose shape (control:true, ipcMethod, admin-only
  // defaultMemberPermissions:"0", ephemeral replies) but is per-AGENT and
  // PERSISTED (verification-state.json, re-applied on boot) rather than
  // per-channel and ephemeral — an operator flipping this expects it to
  // survive a restart, the same way runtime effort does.
  //
  //   /clawcode-verify mode:auto            → when the trail arms
  //   /clawcode-verify profile:legal        → which vocabulary decides "topic"
  //   /clawcode-verify mode:topic profile:finance
  //   /clawcode-verify status               → report agent's live setting
  //   /clawcode-verify reset                → drop override, fall back to yaml
  //
  // Deliberately NOT editable here: the profile's TERMS, and the separate
  // vocabulary behind the corrective-hop classifiers. Those gate what
  // reaches a client and stay in reviewed, deployed code.
  {
    name: "clawcode-verify",
    description:
      "Verification trail: when it shows (mode) and what counts as on-topic (profile)",
    claudeCommand: "",
    control: true,
    ipcMethod: "set-verification",
    options: [
      {
        name: "mode",
        type: 3,
        description: "when the activity trail appears",
        required: false,
        choices: [
          { name: "auto (topic prompts + turns that go quiet & tool-heavy)", value: "auto" },
          { name: "topic (only on-topic prompts)", value: "topic" },
          { name: "always (every turn that uses tools first)", value: "always" },
        ],
      },
      {
        name: "profile",
        type: 3,
        description: "vocabulary that decides a prompt is on-topic",
        required: false,
        choices: [
          { name: "finance (figures, eligibility, tax rules)", value: "finance" },
          { name: "legal (clauses, obligations, terms)", value: "legal" },
          { name: "none (never arms on topic)", value: "none" },
        ],
      },
      {
        name: "action",
        type: 3,
        description: "status (report current) or reset (drop override)",
        required: false,
        choices: [
          { name: "status", value: "status" },
          { name: "reset (fall back to config)", value: "reset" },
        ],
      },
      {
        name: "agent",
        type: 3,
        description: "Agent name (defaults to the channel's bound agent)",
        required: false,
      },
    ],
    defaultMemberPermissions: "0",
  },
  // Phase 999.164 — quick-lane toggle. The /clawcode-verify shape: per-AGENT
  // and PERSISTED (fast-lane-state.json, re-applied on boot), admin-only,
  // ephemeral replies. The quick lane is on for every agent by default; this
  // is how an operator turns it off (or back on) for one agent.
  //
  //   /clawcode-quick              → status + what the quick lane answers here
  //   /clawcode-quick lane:off     → every message takes the full turn
  //   /clawcode-quick lane:on
  //   /clawcode-quick lane:reset   → drop the override, follow config
  {
    name: "clawcode-quick",
    description: "Quick lane (fast ⚡ answers) for this channel's agent: on, off, or status",
    claudeCommand: "",
    control: true,
    ipcMethod: "set-fast-lane",
    options: [
      {
        name: "lane",
        type: 3,
        description: "turn the quick lane on or off, or show what it answers",
        required: false,
        choices: [
          { name: "status (what it answers here)", value: "status" },
          { name: "on", value: "on" },
          { name: "off (every message takes the full turn)", value: "off" },
          { name: "reset (follow config)", value: "reset" },
        ],
      },
      {
        name: "agent",
        type: 3,
        description: "Agent name (defaults to the channel's bound agent)",
        required: false,
      },
    ],
    defaultMemberPermissions: "0",
  },
  // Phase 999.171 — per-agent UX feature toggles. The /clawcode-quick shape:
  // per-AGENT and PERSISTED (ux-feature-state.json, re-applied on boot),
  // admin-only, ephemeral replies. ONE command for all three features (eight
  // slash commands were just retired). Slash routing is frozen at boot, so
  // this command appears after the deploy restart.
  //
  //   /clawcode-ux feature:thinking               → status (effective + source)
  //   /clawcode-ux feature:thinking state:on      → live thinking in the status trail
  //   /clawcode-ux feature:suggestions state:off agent:<name>
  //   /clawcode-ux feature:thinking state:reset   → drop the override; config governs (operator 2026-09-24)
  //   /clawcode-ux feature:research model:sonnet  → researchers' model, next launch (999.173 polish)
  {
    name: "clawcode-ux",
    description: "Per-agent UX features (thinking, status ping, suggestions, research): on, off, status, reset",
    claudeCommand: "",
    control: true,
    ipcMethod: "set-ux-feature",
    options: [
      {
        name: "feature",
        type: 3,
        description: "which UX feature to show or change",
        required: true,
        choices: [
          { name: "thinking (live thinking in status updates)", value: "thinking" },
          { name: "ping (answer 'eta' / 'we good?' from the live trail)", value: "ping" },
          { name: "suggestions (prompt suggestions)", value: "suggestions" },
          { name: "research (research subagents)", value: "research" },
        ],
      },
      {
        name: "state",
        type: 3,
        description: "turn it on or off, show the current state, or reset it to the config value",
        required: false,
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
          { name: "status", value: "status" },
          { name: "reset (back to the config value)", value: "reset" },
        ],
      },
      {
        // 999.173 polish — research only: the researchers' model, applied at
        // the next launch (no restart). reset = back to config / default (opus).
        name: "model",
        type: 3,
        description: "research only: the model researchers launch with (applies to the next launch)",
        required: false,
        choices: [
          { name: "opus", value: "opus" },
          { name: "sonnet", value: "sonnet" },
          { name: "haiku", value: "haiku" },
          { name: "fable", value: "fable" },
          { name: "inherit (the agent's own model)", value: "inherit" },
          { name: "reset (back to config / default)", value: "reset" },
        ],
      },
      {
        name: "agent",
        type: 3,
        description: "Agent name (defaults to the channel's bound agent)",
        required: false,
      },
    ],
    defaultMemberPermissions: "0",
  },
  {
    name: "clawcode-verbose",
    description: "Toggle inline advisor visibility for this channel (on | off | status)",
    claudeCommand: "",
    control: true,
    ipcMethod: "set-verbose-level",
    options: [
      {
        name: "level",
        type: 3, // STRING
        description: "verbose level for this channel",
        required: true,
        choices: [
          { name: "on (inline advisor advice)", value: "on" },
          { name: "off (footer + reaction only)", value: "off" },
          { name: "status (report current setting)", value: "status" },
        ],
      },
    ],
    defaultMemberPermissions: "0",
  },
  // Phase 124 Plan 03 — operator-facing session compaction trigger. Admin-only
  // ephemeral. Mirrors the Phase 95 /clawcode-dream precedent shape (control:
  // true, ipcMethod routes through daemon dispatch, defaultMemberPermissions:
  // "0" hides the command from non-admin Discord users at the API surface).
  //
  // Naming note (Rule 3): operator-requested `/compact` and the obvious
  // alternative `/clawcode-compact` are BOTH reserved.
  //   - `compact` is in native-cc-commands.ts ALLOWED_NATIVES (line 68) as a
  //     prompt-channel passthrough to the SDK's /compact.
  //   - `clawcode-compact` is what the native-CC registration loop produces by
  //     prefixing the SDK name (`clawcode-${cmd.name}` at
  //     native-cc-commands.ts:177); mergeAndDedupe is native-wins
  //     (slash-commands.ts:1050) so any DEFAULT entry with that name is
  //     silently displaced at register time.
  //   - `/clawcode-session-compact` is safe and gives Discord/CLI parity with
  //     the operator-facing `clawcode session compact <agent>` CLI primitive
  //     shipped in Plan 124-02.
  //
  // Wire contract — handler at slash-commands.ts handleCompactCommand routes
  // `sendIpcRequest(SOCKET_PATH, "compact-session", { agent })` to the daemon
  // dispatch case at daemon.ts:10320 (Plan 124-01).
  {
    name: "clawcode-session-compact",
    description: "Compact an agent's session (admin-only; mirrors `clawcode session compact <agent>` CLI)",
    claudeCommand: "",
    control: true,
    ipcMethod: "compact-session",
    options: [
      {
        name: "agent",
        type: 3, // STRING
        description: "Agent name to compact",
        required: true,
      },
    ],
    defaultMemberPermissions: "0",
  },
  // Phase 132 Plan 03 — operator review surface for candidate skill drafts
  // staged by the out-of-band Haiku 4.5 distiller (Plan 02). Three slash
  // commands (D-06 locked: slash NOT buttons because Phase v1.x has no
  // daemon-side button-interaction infra yet — see CONTEXT.md §decisions
  // D-06). All three are admin-only-ephemeral matching the /clawcode-dream
  // precedent (defaultMemberPermissions: "0" hides them from non-admin
  // Discord users at the API surface; the inline-short-circuit handler in
  // slash-commands.ts additionally gates on isAdminClawdyInteraction
  // BEFORE deferReply so non-admins get an instant ephemeral reject).
  //
  // Wire contract:
  //   /approve-skill <draft-id>          → ipcMethod "approve-skill-draft"
  //   /reject-skill <draft-id> [reason]  → ipcMethod "reject-skill-draft"
  //   (/edit-skill <draft-id> → "edit-skill-draft" was retired 2026-09-23.)
  //
  // The handlers (src/manager/skill-draft-actions.ts):
  //   approveDraft : moves staging → skills/<slug>/SKILL.md (D-04)
  //   rejectDraft  : moves staging → skills-rejected/, preserving the
  //                  fingerprint12 substring in the filename (D-07 sticky-
  //                  rejection dedup substrate — the distiller's next-
  //                  trajectory scan reads the same substring)
  //   locate-for-edit : returns the absolute draft path so the operator can
  //                     scp-edit then re-/approve. NO in-Discord editor at
  //                     v1 — CONTEXT §Claude's Discretion locks this posture.
  {
    name: "approve-skill",
    description:
      "Approve a Phase 132 candidate skill draft (moves it to the agent's active skills directory)",
    claudeCommand: "",
    control: true,
    ipcMethod: "approve-skill-draft",
    options: [
      {
        name: "draft-id",
        type: 3,
        description:
          "Draft id (e.g. find-clients-by-industry-2026-05-16-120000-abc123def456)",
        required: true,
      },
    ],
    defaultMemberPermissions: "0",
  },
  {
    name: "reject-skill",
    description:
      "Reject a Phase 132 candidate skill draft (archives with fingerprint for sticky-rejection dedup)",
    claudeCommand: "",
    control: true,
    ipcMethod: "reject-skill-draft",
    options: [
      {
        name: "draft-id",
        type: 3,
        description:
          "Draft id (e.g. find-clients-by-industry-2026-05-16-120000-abc123def456)",
        required: true,
      },
      {
        name: "reason",
        type: 3,
        description: "Optional rejection reason",
        required: false,
      },
    ],
    defaultMemberPermissions: "0",
  },
  // 2026-09-23 — /edit-skill and the Phase 999.42 patch commands
  // (/patch-skill, /approve-patch, /reject-patch) were retired: the operator never used
  // them. /approve-skill and /reject-skill stay because they are the only way to
  // apply or discard the drafts /clawcode-optimize stages. The daemon IPC
  // handlers behind the retired commands are untouched.
] as const;
