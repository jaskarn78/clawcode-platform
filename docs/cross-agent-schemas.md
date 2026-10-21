# Cross-Agent Task Schemas

ClawCode's `delegate_task` MCP tool delivers a **typed task** from one agent to another. The receiving agent gets the payload as a new turn and replies with `task_complete(task_id, result)`. The system validates the payload against a registered schema and an allowlist before the task is dispatched.

This document describes where schemas live, how agents declare which schemas they accept, and how senders discover what's accepted before calling `delegate_task`.

## Two-layer model

A delegation succeeds only when BOTH layers are satisfied:

1. **Fleet schema registry** — the schema YAML file exists in
   `~/.clawcode/task-schemas/`. This proves the schema's input/output shape is
   defined system-wide. Without this file, `delegate_task` returns
   `unknown_schema` no matter what the target's config says.

2. **Per-agent allowlist** — the target agent's `clawcode.yaml` entry
   includes the schema in its `acceptsTasks` map, with the caller's name in
   the array of allowed senders. Without this entry, `delegate_task` returns
   `Unauthorized`.

Schemas in one layer but not the other are not delegatable. The
`list_agent_schemas` tool returns both flags so senders can see exactly
which gate they're hitting.

## Layer 1: Schema YAML files

**Location**: `~/.clawcode/task-schemas/<name>.yaml`

**Shape**:

```yaml
name: research.brief
description: Short research brief for a topic
input:
  type: object
  properties:
    topic: { type: string }
    audience: { type: string }
  required: [topic]
output:
  type: object
  properties:
    summary: { type: string }
    citations: { type: array, items: { type: string } }
  required: [summary]
```

The daemon loads `~/.clawcode/task-schemas/*.yaml` at startup via
`SchemaRegistry.load()` (see `src/tasks/schema-registry.ts`). Malformed
files are skipped with a warn log; the directory missing entirely is
tolerated (empty registry, "first-boot tolerance"). Reload requires a
daemon restart — there is no hot-reload watcher today.

## Layer 2: Per-agent `acceptsTasks`

**Location**: `clawcode.yaml` under each agent's entry.

**Shape**:

```yaml
agents:
  - name: projects
    model: sonnet
    acceptsTasks:
      research.brief: [admin-clawdy, fin-research]
      data.export: [admin-clawdy]
```

`acceptsTasks` is a map: `<schema-name> → <list-of-allowed-caller-names>`.
An agent with no `acceptsTasks` map (or with an empty one) accepts NO
delegations — every `delegate_task` returns `UnauthorizedError`.

Validated by `src/config/schema.ts:1419` and consumed by
`src/tasks/authorize.ts:checkAllowlist`.

## Discovery — how senders find valid schemas

Senders introspect with the `list_agent_schemas` MCP tool:

```
list_agent_schemas(caller="admin-clawdy", target="projects")

→ Schemas declared by 'projects' (from clawcode.yaml acceptsTasks):
    - research.brief (callerAllowed=true, registered=true)
    - data.export (callerAllowed=true, registered=true)
    - bug.report (callerAllowed=true, registered=false)
```

The two flags mean:

- `callerAllowed` — the caller is on the target's per-schema allowlist.
- `registered` — the schema's YAML file exists in
  `~/.clawcode/task-schemas/`.

Both must be `true` for `delegate_task` to succeed. A schema with
`registered=false` (like `bug.report` in the example above) means an
operator added it to `acceptsTasks` but never authored the YAML — the
delegation will fail with `unknown_schema` until the file is added.

## What happens on rejection

When `delegate_task` is called with a schema the target hasn't registered,
the MCP tool result now includes the accepted list:

```
delegate_task(caller="admin-clawdy", target="projects", schema="bug.report", ...)

→ Delegate failed: schema 'bug.report' is not accepted by 'projects'.
  Accepted schemas: research.brief, data.export.
  Call list_agent_schemas(caller, target) to inspect each schema's
  callerAllowed flag.
```

This replaces the previous opaque `Delegate failed: schema 'bug.report'
not in registry` rejection. The sender's LLM can retry with a valid
schema, or fall back to `ask_agent` for a free-form question — NOT to
`post_to_agent`, which is fire-and-forget and was the source of Admin
Clawdy's 2026-05-11 silent-drop bug (see Quick 260511-pw2).

## Adding a new cross-agent schema

To make `<schema-name>` delegatable from `<caller-name>` to `<target-name>`:

1. Create `~/.clawcode/task-schemas/<schema-name>.yaml` with `name`,
   `input`, `output` keys. Restart the daemon.
2. Edit `<target-name>`'s entry in `clawcode.yaml`. Add or extend:
   ```yaml
   acceptsTasks:
     <schema-name>: [<caller-name>, ...]
   ```
3. Restart the daemon (or hot-reload the config if supported).
4. Verify with `list_agent_schemas(caller, target)` — the schema should
   appear with `callerAllowed=true, registered=true`.

## References

- Registry loader: `src/tasks/schema-registry.ts`
- Validation pipeline: `src/tasks/task-manager.ts:delegate` (6-step check)
- Allowlist check: `src/tasks/authorize.ts:checkAllowlist`
- IPC handlers: `src/manager/daemon.ts` cases `delegate-task` and
  `list-agent-schemas`
- MCP tools: `src/mcp/server.ts` (`delegate_task`, `list_agent_schemas`)
- Quick task that added introspection: Quick 260511-pw3
