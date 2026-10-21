# ClawCode

ClawCode is a self-hosted multi-agent orchestration platform built on
[Claude Code](https://claude.ai/code). It runs several persistent AI agents on
one machine. Each agent is a long-lived Claude Code session (through the Claude
Agent SDK) with its own identity files, workspace, memory store and Discord
channel, and a central daemon manages them.

Status: version 1.2.8. The code was extracted from a private deployment, so some
modules are larger and more operator-specific than a fresh project would be. See
[Known issues](#known-issues) before relying on it.

## What it does

- **Persistent agents.** Each agent has `SOUL.md` / `IDENTITY.md` identity
  text, a workspace directory and per-agent SQLite databases (memory, usage,
  delivery queue, conversation log). A daemon starts, monitors and restarts them.
- **Discord front end.** Channel-to-agent routing, threads, attachments,
  reactions, webhooks with per-agent identity, slash commands, and a reliable
  outbound delivery queue.
- **Memory.** Per-agent SQLite with FTS5 keyword search and `sqlite-vec` vector
  search, local embeddings (no embedding API), tiered storage, consolidation
  into digests, and MCP tools for search, recall and curated edits.
- **MCP tooling.** Auto-injected MCP servers for memory, browser, web search,
  image generation, thread spawning, scheduling and agent-to-agent messaging.
  Static Go shims (`cmd/clawcode-mcp-shim`) keep the per-agent MCP processes
  small. A broker pools 1Password access.
- **Agent-to-agent messaging.** A durable task store plus a loop governor that
  bounds conversation depth, pair rate and per-conversation length.
- **Advisor pattern.** An executor model can consult a stronger reviewer model
  mid-turn (`src/advisor`); the legacy fork-to-Opus path stays as a rollback.
- **Scheduling and triggers.** Cron-style tasks, a trigger engine with a policy
  DSL, recurring schedules that post to a channel.
- **OpenAI-compatible endpoint.** `/v1/chat/completions` and `/v1/models`
  (default port 3101) with per-key session continuity.
- **Web dashboard.** A React single-page app served by the daemon (default
  `127.0.0.1:3100`).
- **Document ingestion.** PDF, docx, xlsx, images and text, with OCR fallback.
- **Optional pieces.** Discord voice (Deepgram speech-to-text, ElevenLabs
  text-to-speech), Slack messaging, Playwright browser automation, bubblewrap
  (`bwrap`) filesystem sandboxing per agent.
- **Operator CLI.** `clawcode status`, `routes`, `health`, `costs`, `latency`,
  `memory`, `skills`, `a2a`, `secrets`, `versions` and more (`clawcode --help`).

## Requirements

- Node.js 22 LTS and npm
- The [Claude Code CLI](https://claude.ai/code), logged in (`claude login`)
- Linux for the daemon. Optional: Go 1.25+ to build the MCP shims, `bwrap` for
  the sandbox, the 1Password CLI (`op`) for 1Password secret references,
  Tesseract for scanned-PDF OCR, a Discord bot token for the Discord front end

## Build

```bash
npm ci
npm run build        # tsup bundle + channel servers + dashboard SPA + assets
npm run typecheck    # tsc --noEmit
npm test             # vitest
```

The build writes `dist/`. In a source checkout there is no `prebuilds/`
directory, so the `postinstall` hook prints a notice and skips installing a
prebuilt MCP shim. Build the shim yourself with
`go build -o clawcode-mcp-shim ./cmd/clawcode-mcp-shim` and set
`defaults.shimRuntime` to `node` for any shim type you have not built (the Node
implementations remain as the fallback).

## Run

```bash
cp clawcode.example.yaml clawcode.yaml   # gitignored; edit it
node dist/cli/index.js start-all          # daemon + all autoStart agents
node dist/cli/index.js status
```

`clawcode.example.yaml` is a small, valid configuration with two agents and
placeholder Discord ids and secret references. The schema is in
`src/config/schema.ts`. Secrets are referenced as `op://example-vault/<item>/<field>`
(1Password; substitute your own vault name) or `${ENV_VAR}` in MCP server `env` blocks; do not put literal
tokens in the file.

For a systemd install on Ubuntu, `scripts/install.sh` creates a `clawcode`
service user and a hardened unit. Read it before running it as root.

## Layout

| Path | Contents |
| --- | --- |
| `src/manager` | Daemon, session manager, turn dispatch, heartbeat, recovery |
| `src/discord`, `src/messaging` | Discord and Slack front ends |
| `src/memory`, `src/documents`, `src/document-ingest` | Memory stores, retrieval, ingestion |
| `src/mcp`, `src/channels` | MCP servers, broker, channel hooks |
| `src/config` | Zod schema, loader, hot-reload differ |
| `src/openai` | OpenAI-compatible HTTP endpoint |
| `src/dashboard` | Dashboard server and React client |
| `src/advisor`, `src/collaboration`, `src/triggers`, `src/scheduler` | Advisor, agent-to-agent, triggers, cron |
| `cmd/`, `internal/` | Go MCP shim |
| `skills/` | Bundled skills |

## Known issues

- The test suite is not green. Run `npm test` for the current result; the
  numbers recorded when this tree was prepared are in `REPORT.md`.
- `go test ./...` has one failing test in `internal/shim/search`
  (`TestIntegrationImageBrowserStubsExitUsage` expects exit code 64 and gets 75).
- The OpenAI-compatible endpoint is enabled by default and binds `0.0.0.0`.
  Set `defaults.openai.host: 127.0.0.1` or `defaults.openai.enabled: false` if
  you do not want it reachable from the network. See `SECURITY.md`.
- Some code and comments still use internal phase numbers and operator
  vocabulary from the original deployment.

## Security

Report vulnerabilities by email, not in public issues. See [SECURITY.md](SECURITY.md).

## License

MIT. See [LICENSE](LICENSE).
