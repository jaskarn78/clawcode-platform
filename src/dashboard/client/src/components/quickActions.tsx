/**
 * Phase 116-postdeploy 2026-05-12 — shared quick-action handlers.
 *
 * Used by FleetLayout's Basic-mode quick-action buttons AND by the Cmd+K
 * command palette so the operator experience is consistent across both
 * surfaces. Removes the placeholder `console.info` paths that 116-02 left
 * behind.
 *
 * All handlers return Promises so callers can `await` them and decide
 * whether to close the palette / show busy state. Status is surfaced via
 * the ActionToast singleton (no toast provider — fixed-position banner).
 */
import { showActionToast } from './ActionToast'

type HealthCheckPayload = {
  readonly agents?: ReadonlyArray<{
    readonly name: string
    readonly healthy?: boolean
    readonly status?: string
  }>
  readonly checks?: ReadonlyArray<{ readonly name: string; readonly ok: boolean }>
  readonly [key: string]: unknown
}

/**
 * Run health check — GETs /api/health (proxies daemon `heartbeat-status`
 * IPC) and surfaces the result via ActionToast. Click navigates the
 * operator to the Fleet view for full per-agent detail.
 */
export async function runHealthCheckAction(opts: {
  readonly onNavigateToFleet?: () => void
}): Promise<void> {
  showActionToast({
    title: 'Running health check…',
    body: 'Polling daemon heartbeat-status',
    tone: 'info',
    durationMs: 0,
  })
  try {
    const r = await fetch('/api/health', { credentials: 'same-origin' })
    if (!r.ok) {
      showActionToast({
        title: 'Health check failed',
        body: `Daemon returned HTTP ${r.status}`,
        tone: 'error',
      })
      return
    }
    const data = (await r.json()) as HealthCheckPayload

    // Heartbeat-status shape varies — try a couple known fields and fall
    // back to "received" if neither is present.
    const agents = data.agents ?? []
    const totalAgents = agents.length
    let healthyCount = 0
    let failingCount = 0
    for (const a of agents) {
      const healthy =
        a.healthy === true ||
        a.status === 'active' ||
        a.status === 'idle' ||
        a.status === 'healthy' ||
        a.status === 'ok'
      if (healthy) healthyCount++
      else failingCount++
    }

    if (totalAgents === 0) {
      showActionToast({
        title: 'Health check returned',
        body: 'Daemon responded but no per-agent rows were included.',
        tone: 'warn',
      })
      return
    }

    const tone: 'success' | 'warn' | 'error' =
      failingCount === 0
        ? 'success'
        : failingCount < totalAgents / 2
        ? 'warn'
        : 'error'
    const body = `${healthyCount}/${totalAgents} agents healthy${
      failingCount > 0 ? ` · ${failingCount} need attention` : ''
    }${opts.onNavigateToFleet ? ' · click banner to view fleet' : ''}`
    showActionToast({
      title: 'Health check complete',
      body,
      tone,
    })
    // Optional: navigate to fleet view after a short delay so the
    // operator sees the toast first. (Future improvement: clickable
    // toast — would need to thread a click handler through the host.)
    if (opts.onNavigateToFleet && failingCount > 0) {
      setTimeout(() => opts.onNavigateToFleet?.(), 1500)
    }
  } catch (err) {
    showActionToast({
      title: 'Health check failed',
      body: (err as Error).message,
      tone: 'error',
    })
  }
}

/**
 * Restart daemon — POST /api/daemon/restart. The IPC handler sends
 * SIGHUP to the daemon process; systemd rebuilds it with Phase 999.6
 * snapshot/restore preserving running agents.
 *
 * Original design was a Discord-bridge-only restart, but DiscordBridge's
 * stop() destroys the discord.js Client and every captured reference in
 * dependent managers (webhooks, subagent threads, restart-greeting bot-
 * direct sender) becomes invalid. Full daemon restart is the only safe
 * one-button path today. Operator confirmation modal is the caller's
 * responsibility.
 */
export async function restartDaemonAction(): Promise<void> {
  showActionToast({
    title: 'Restarting daemon…',
    body: 'systemd will restart the process; reconnect in ~3-5s',
    tone: 'info',
    durationMs: 0,
  })
  try {
    const r = await fetch('/api/daemon/restart', {
      method: 'POST',
      credentials: 'same-origin',
    })
    if (!r.ok) {
      let detail = `HTTP ${r.status}`
      try {
        const data = (await r.json()) as { error?: string }
        if (typeof data.error === 'string') detail = data.error
      } catch {
        /* body wasn't JSON — keep HTTP status */
      }
      showActionToast({
        title: 'Daemon restart failed',
        body: detail,
        tone: 'error',
        durationMs: 8000,
      })
      return
    }
    showActionToast({
      title: 'Daemon restarting',
      body: 'systemd is rebuilding the process; this page may briefly disconnect',
      tone: 'success',
      durationMs: 6000,
    })
  } catch (err) {
    // Mid-restart, the fetch may abort with a network error AFTER the
    // daemon accepted SIGHUP. That's expected — surface as info, not error.
    showActionToast({
      title: 'Daemon restart in progress',
      body: `${(err as Error).message} — refresh in a few seconds`,
      tone: 'info',
      durationMs: 6000,
    })
  }
}
