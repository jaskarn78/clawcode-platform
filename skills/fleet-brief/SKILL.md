---
name: fleet-brief
description: Assemble the daily fleet health digest — memory, incidents, agent status, and drift — from IPC/CLI and dashboard sources.
version: 1.2.0
owner: "*"
capabilities: [filesystem, network]
requiredTools: []
requiredMcpServers: []
slashCommand: true
---
Assemble the daily fleet health digest — memory, incidents, agent status, and drift — from IPC/CLI and dashboard sources.

## When this skill applies

The daily `fleet-brief` schedule, the `/fleet-brief` slash command, or any "how's the fleet" ask.

## Sources that actually work (verified on prod 2026-09-02; health additions 2026-09-05)

The dashboard API is served in-process by the daemon on **port 3100** and every GET is
ungated, so it needs no credentials. Prefer it — it is the only source that is both
complete and permitted.

| want | use |
|---|---|
| memory / cgroup / MCP RSS | `curl -s localhost:3100/api/fleet-stats` |
| agent status, restarts, warm-path | `curl -s localhost:3100/api/status` — or `clawcode status` |
| per-agent health checks, **24 h incidents**, **memory census** | `curl -s localhost:3100/api/health` — or `clawcode health` |
| schedules | `curl -s localhost:3100/api/schedules` — or `clawcode schedules` |
| costs | `curl -s localhost:3100/api/costs` |
| skills | `clawcode skills` (bare — **not** `clawcode skills list`, which reads "list" as an agent name) |

Known-bad, do not use:

- **Port 3777** — nothing listens there. It was in this skill until 2026-09-02 and returned
  connection-refused every morning, which is why the memory section was routinely thin.
- **`clawcode costs`** — throws `Cannot read properties of undefined (reading 'toLocaleString')`.
  Use `/api/costs` and sum `cost_usd` yourself.
- **`journalctl`** — the `clawcode` service account is in neither `adm` nor `systemd-journal`,
  so every journal read returns "No journal files were opened due to insufficient permissions."
  This is a standing condition, not a transient one: **do not test it, do not mention it, and do
  not report it as a finding.** See "Incidents" below for what to do instead.

## What `/api/health` carries

- `agents.<name>.checks.<check>` — `{status, message, lastChecked, metadata?}` for every
  heartbeat check. `status` is `healthy` / `warning` / `critical`; `overall` is the worst.
- `incidents` — every status CHANGE in the last 24 h, oldest first:
  `transitions[] = {timestamp, agent, check, from, to, message}` and
  `byAgent.<name> = {warning, critical, recovered, open[]}`. `open[]` lists checks whose
  latest transition is still not healthy. A check that degraded at 03:00 and recovered by
  08:00 is here even though `checks` shows it healthy now. (Absent on a daemon older than
  2026-09-05: then fall back to `checks` only.)
- `checks["memory-census"]` — the `memory doctor` numbers, refreshed every 15 min, in
  `metadata`: `memories`, `tierCounts` (hot/warm/cold), `integrity` (`fkViolations`,
  `total` repairable orphans, `memoriesWithoutEmbedding`), `coldFiles` (legacy archive
  files not yet imported), `sessions` (`active`, `staleActive`, `emptyTerminated`),
  `embedding` (`readVersion`, `v2Coverage` 0..1). A healthy message is one line of sizes;
  a `warning` message names the problems and the exact repair command.

## Data gathering (in this order; each section degrades gracefully)

1. **Memory** — `/api/fleet-stats` → `cgroup.memoryCurrentBytes` vs `memoryMaxBytes` and
   `memoryPercent`; `claudeProcDrift` (`liveCount` vs `trackedCount` — any non-zero `drift` is
   worth a line); `mcpFleet[]` for per-pattern MCP RSS. Report the largest `rssMB` entries only
   if one looks abnormal.
2. **Agents** — `/api/status` or `clawcode status`: every expected agent `running`? Compare
   `restartCount` against yesterday's brief. Anything stuck `starting`? Any non-null `lastError`?
   (Never restart anything from this skill — observe and report; process actions require the
   operator, per your standing directives.)
3. **Incidents** — the journal is not readable by this account (above), so use what is:
   - `/api/health` `incidents.transitions` — group by agent; report every transition INTO
     `warning` or `critical` with the check's own message, and say whether it recovered
     (`byAgent.<agent>.recovered`, and whether the check is in `open[]`). Skip transitions
     whose `from` is null and `to` is `healthy` (there are none; first observations are only
     journaled when unhealthy).
   - `/api/health` `checks` — anything currently `warning`/`critical` that has no transition
     in the window has been that way for more than a day: say so ("still warning since before
     yesterday").
   - `/api/status` `restartCount` deltas — a climbing count is the crash signal the journal's
     `"level":50` grep used to provide.
   - If the operator wants journal-grade detail (memory-guard census, `activeBreaches`, wedge
     counts, suppressed-alert lines), say so in one clause and stop. Do not attempt a workaround,
     and do not ask for sudo.
4. **Memory integrity** — `/api/health` `checks["memory-census"]` per agent. Report only
   agents whose census is `warning`, quoting its message (it already names the problems and the
   repair command, `clawcode memory doctor -a <agent> --repair`). Never run the repair from this
   skill; it changes data and is the operator's call. If every agent is healthy, one clause:
   "memory integrity clean fleet-wide (v2 reads NN%)" using the lowest `v2Coverage` you saw.
5. **Schedules** — `/api/schedules` or `clawcode schedules`: anything `disabled`, or a
   `lastStatus` that is not `pending`/`ok`?
6. **Skills** — `clawcode skills`: any ⚠️ unloaded/refused?
7. **Costs** — `/api/costs` returns `costs[]` of `{agent, input_tokens, output_tokens, cost_usd}`
   for `period: "today"`. Sum `cost_usd` for the one-line total; name an agent only if it
   dominates.

## Output format (≤15 lines, auto-posts to the admin channel)

- Line 1: 🟢/🟡/🔴 headline verdict with the single most important fact.
- Memory: `cgroup X.XG / ceiling Y.YG (NN%)` + trend vs yesterday + top class if abnormal.
- Incidents: only transitions into warning/critical and restart-count climbs, each with the
  agent name, the check, and recovered-or-open.
- Memory integrity: only agents with a `warning` census, one line each; else one clause.
- Agents: only exceptions (down/crashed/stuck).
- Anything merged-but-undeployed or config drift you can detect from the data above.
- If everything is green: say so in ≤3 lines total. Detail is for surprises only.

## Rules

- Numbers verbatim from sources — never estimate memory or counts.
- One digest per invocation; do not spawn subagents or workflows for this.
- If a data source errors, name it in one clause and move on — a partial brief on time beats a
  complete brief late.
