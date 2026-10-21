# `src/llm/` — Provider-neutral LLM seam

## Purpose

Provider-neutral LLM seam for ClawCode. Phase 117 lands the interface
(`CompletionProvider` in [`provider.ts`](./provider.ts)); the first consumer
is Phase 118 `PortableForkAdvisor`. Call sites depend on the interface, not
on any concrete SDK, so non-Anthropic backends can slot in per agent via
config without touching advisor or call-site code.

## Current state

**Interface only. No implementations exist in this phase.**

`grep -rn "implements CompletionProvider" src/` returns zero matches by
design. Every concrete provider lands in a later phase under
[`src/llm/`](.).

## Planned providers

| Provider                  | Backend                                           | Status                 |
| ------------------------- | ------------------------------------------------- | ---------------------- |
| `AnthropicDirectProvider` | `@anthropic-ai/sdk` raw API (bypasses Agent SDK)  | Phase 118 (first impl) |
| `OpenAIProvider`          | OpenAI Chat Completions / Responses API           | Phase 119+             |
| `BedrockProvider`         | AWS Bedrock (Anthropic + others)                  | Phase 119+             |
| `VertexProvider`          | Google Vertex AI (Anthropic + Gemini)             | Phase 119+             |
| `OllamaProvider`          | Local Ollama (offline / on-prem)                  | Phase 119+             |

## Why not the agent SDK?

ClawCode already runs Claude Code sessions via
`@anthropic-ai/claude-agent-sdk`. The native advisor path
(`AnthropicSdkAdvisor`, Phase 117 Plan 04) uses the SDK's `advisorModel`
option directly and does NOT need `CompletionProvider`.

`CompletionProvider` exists for paths that **bypass** the Agent SDK —
specifically the portable-fork advisor (Phase 118), which extracts an
agent's transcript and replays it against a raw provider API so the same
advisor pattern can run against non-Anthropic backends. Future
non-Anthropic providers slot here without disturbing the SDK-backed
session path.

## Reference

- Approved plan: `/home/example-user/.claude/plans/eventual-questing-tiger.md`
  (Interfaces §, lines 117–128 — canonical interface shape)
- Phase context: [`../../.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md`](../../.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-CONTEXT.md)
  (`<decisions>` — Architecture LOCKED)
- Research notes: [`../../.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md`](../../.planning/phases/117-claude-code-advisor-pattern-multi-backend-scaffold-anthropic/117-RESEARCH.md)
  (§1 user constraints, §3 file map row for `src/llm/`)
