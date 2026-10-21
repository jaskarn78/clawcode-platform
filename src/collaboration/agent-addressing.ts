/**
 * Phase 999.117 WS-5 — agent-name resolution for agent-to-agent messaging.
 *
 * WHY THIS EXISTS
 *
 * `to` was matched by exact string equality against the config. That is a
 * hostile contract for an LLM caller:
 *
 *   - one production agent is named `"Admin Clawdy"` — a space AND capitals,
 *     so `to: "admin"`, `to: "admin-clawdy"` and `to: "Admin"` all failed
 *   - the failure was a bare `Target agent 'admin' not found` with no list of
 *     what WOULD work, so the model had nothing to correct against and would
 *     either guess again or give up silently
 *   - every other agent is kebab-case, making the odd one out the single most
 *     likely target to mistype (it is the fleet coordinator)
 *
 * Resolution order is deliberately strict-to-loose, and every step must be
 * UNAMBIGUOUS. Silently delivering a message to the wrong agent is far worse
 * than failing — the sender cannot tell, and neither can the operator.
 *
 *   1. exact name match
 *   2. exact alias match (operator-declared, so it is intent, not a guess)
 *   3. unique normalised match (case/space/dash/underscore-insensitive)
 *   4. unique normalised prefix or substring match
 *
 * Anything matching more than one agent resolves to nothing.
 */

/** An agent as far as addressing is concerned. */
export type AddressableAgent = Readonly<{
  name: string;
  aliases?: readonly string[];
}>;

export type AgentResolution =
  | Readonly<{ kind: "exact"; name: string }>
  | Readonly<{ kind: "alias"; name: string; matched: string }>
  | Readonly<{ kind: "normalised"; name: string }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly string[] }>
  | Readonly<{ kind: "unknown"; suggestion?: string }>;

/**
 * Fold away the differences an LLM is most likely to get wrong: casing, and
 * whether the separator is a space, dash or underscore. Deliberately does NOT
 * strip other punctuation — that would start merging genuinely distinct names.
 */
export function normaliseAgentName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

/**
 * Resolve a requested agent name against the fleet.
 *
 * Never throws. The caller decides how to present `ambiguous` / `unknown`;
 * both carry enough detail to write a message the sender can act on.
 */
export function resolveAgentName(
  wanted: string,
  agents: readonly AddressableAgent[],
): AgentResolution {
  const exact = agents.find((a) => a.name === wanted);
  if (exact) return { kind: "exact", name: exact.name };

  // 2. Operator-declared aliases. Checked before fuzzy matching because an
  //    alias is a stated intent, not an inference.
  for (const agent of agents) {
    for (const alias of agent.aliases ?? []) {
      if (alias === wanted) {
        return { kind: "alias", name: agent.name, matched: alias };
      }
    }
  }

  const target = normaliseAgentName(wanted);
  if (target.length === 0) return { kind: "unknown" };

  // 3. Normalised equality, over names AND aliases.
  const normalisedHits = agents.filter(
    (a) =>
      normaliseAgentName(a.name) === target ||
      (a.aliases ?? []).some((al) => normaliseAgentName(al) === target),
  );
  if (normalisedHits.length === 1) {
    return { kind: "normalised", name: normalisedHits[0].name };
  }
  if (normalisedHits.length > 1) {
    return { kind: "ambiguous", candidates: normalisedHits.map((a) => a.name) };
  }

  // 4. Unique prefix / substring. This is the loosest step and the one most
  //    able to be wrong, so ambiguity here resolves to nothing rather than a
  //    coin flip: "fin" must never silently pick fin-research over
  //    fin-client.
  const partial = agents.filter((a) => {
    const candidates = [a.name, ...(a.aliases ?? [])].map(normaliseAgentName);
    return candidates.some((c) => c.startsWith(target) || c.includes(target));
  });
  if (partial.length === 1) return { kind: "normalised", name: partial[0].name };
  if (partial.length > 1) {
    return { kind: "ambiguous", candidates: partial.map((a) => a.name) };
  }

  return { kind: "unknown" };
}

/**
 * Build the operator/LLM-facing failure text for a resolution that did not
 * land on exactly one agent.
 *
 * Always lists the valid targets. The whole point is that the NEXT tool call
 * succeeds without the model having to guess a second time.
 */
export function describeResolutionFailure(
  wanted: string,
  resolution: AgentResolution,
  agents: readonly AddressableAgent[],
): string {
  const valid = agents.map((a) => `'${a.name}'`).join(", ");
  if (resolution.kind === "ambiguous") {
    const candidates = resolution.candidates.map((c) => `'${c}'`).join(", ");
    return (
      `Agent name '${wanted}' is ambiguous — it matches ${candidates}. ` +
      `Use the exact name. Valid agents: ${valid}.`
    );
  }
  return (
    `Target agent '${wanted}' not found. Valid agents: ${valid}. ` +
    `Agent names are matched exactly first, then by alias, then ignoring ` +
    `case and spaces/dashes.`
  );
}
