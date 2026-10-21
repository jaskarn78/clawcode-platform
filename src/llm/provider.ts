/**
 * Provider-neutral LLM completion seam.
 *
 * Phase 117 (scaffold): this file declares the `CompletionProvider`
 * interface only — there are NO implementations in this phase. The
 * interface seeds a future abstraction layer so non-Anthropic backends
 * (OpenAI, Bedrock, Vertex, Ollama, etc.) can slot in without touching
 * advisor or call-site code.
 *
 * First consumer: Phase 118 `PortableForkAdvisor`, which will pair with
 * a concrete `AnthropicDirectProvider` (raw `@anthropic-ai/sdk` calls
 * that bypass the Claude Agent SDK so the advisor can run over an
 * extracted transcript replay).
 *
 * See:
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`
 *     (decisions.Architecture — LOCKED: "Provider-neutral interface at
 *     `src/advisor/` and `src/llm/`. ... Future non-Anthropic providers
 *     slot into `src/llm/` without touching advisor code.")
 *   - `.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`
 *     (§1, §3 file map row for `src/llm/provider.ts`)
 *   - `/home/example-user/.claude/plans/eventual-questing-tiger.md`
 *     (Interfaces §, lines 117–128 — canonical interface shape)
 */

/**
 * Abstract LLM completion provider.
 *
 * Implementations bridge ClawCode to a single backend (e.g. Anthropic
 * Direct, OpenAI, Bedrock). Consumers depend on this interface only —
 * never on a concrete SDK — so the provider can be swapped per agent
 * via config without touching call-site code.
 *
 * Capability flags advertise what the underlying backend supports so
 * callers can route requests intelligently:
 *   - `advisorTool` — backend supports the Anthropic `advisor_20260301`
 *     server tool (or an equivalent server-side advisor primitive).
 *   - `toolUse` — backend supports tool-use / function-calling.
 */
export interface CompletionProvider {
  readonly id: string;
  readonly capability: { advisorTool: boolean; toolUse: boolean };
  complete(req: {
    model: string;
    system: string;
    messages: ReadonlyArray<{ role: "user" | "assistant"; content: string }>;
    maxTokens?: number;
  }): Promise<{ text: string; tokensIn: number; tokensOut: number }>;
}
