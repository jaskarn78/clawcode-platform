/**
 * Phase 140 — `V3UnsupportedMutatorError`.
 *
 * The `claude-code-interactive` backend (v3) drives Discord turns through
 * the agent's own `claude --channels` session — the daemon does NOT hold an
 * in-process `Query`. Consequently the mid-session control-plane mutators the
 * Agent SDK exposes on a `Query` (`setModel`, `setPermissionMode`,
 * `interrupt`) and the module-level `forkSession` have no live target.
 *
 * Rather than silently no-op (which would mask a real bug — e.g. a
 * compaction-fork or advisor-fork call site reaching the wrong backend), the
 * `FakeChannelsSdkModule` throws this typed error. Call sites that legitimately
 * need these primitives must keep the affected agent on the masking/SDK
 * backend (the permanent per-agent fallback via Phase-138 `failover`), or use
 * the v3-native replacement documented at the call site (Stage 2+):
 *   - compaction-fork  → transcript replay (`getSessionMessages`)
 *   - advisor-fork     → programmatic Opus one-shot seeded from the transcript
 *   - interrupt / abort → PTY supervisor restart (coarse; Stage 2)
 *
 * The `mutator` field names the offending primitive so operator alerts and
 * tests can branch on it without string-matching the message.
 */
export class V3UnsupportedMutatorError extends Error {
  /** The control-plane primitive that has no live target under v3. */
  readonly mutator: string;
  /** Agent whose session the call targeted (for operator triage). */
  readonly agent: string;

  constructor(mutator: string, agent: string) {
    super(
      `'${mutator}' is unsupported on the claude-code-interactive (v3) backend ` +
        `for agent "${agent}": the daemon holds no in-process Query — the ` +
        `agent's own \`claude --channels\` session drives turns. Keep this ` +
        `agent on the masking/SDK backend (\`clawcode failover set ${agent} ` +
        `anthropic-agent-sdk\`) if it needs this primitive, or use the ` +
        `v3-native replacement documented in v3-unsupported-mutator.ts.`,
    );
    this.name = "V3UnsupportedMutatorError";
    this.mutator = mutator;
    this.agent = agent;
  }
}
