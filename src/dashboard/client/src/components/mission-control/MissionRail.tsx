/**
 * dash-redesign (Mission Control) — right rail (Live activity + Tasks).
 *
 * Two stacked panels:
 *   - Live activity : useActivityFeed (placeholder hook today — empty
 *                     state renders the explainer text until the
 *                     operator-activity SSE channel is wired)
 *   - Tasks         : useRecentTasks  (real kanban-flattened data;
 *                     top 5 by started_at DESC)
 */
import type { JSX } from 'react'
import {
  useActivityFeed,
  useRecentTasks,
  type ActivityFeedItem,
  type RecentTask,
} from '@/hooks/useApi'
import { Icon, type IconName } from './icons'

const FEED_TYPE_TO_ICON: Record<ActivityFeedItem['type'], IconName> = {
  advisor: 'brain',
  escalation: 'siren',
  discord: 'chat',
  memory: 'bolt',
}

function FeedItem(props: { readonly item: ActivityFeedItem }): JSX.Element {
  const { item } = props
  return (
    <div className={`feed-item ${item.type}`} data-testid="mission-feed-item">
      <span className="ic">
        <Icon name={FEED_TYPE_TO_ICON[item.type]} size={14} />
      </span>
      <div className="body">
        <span className="agent">{item.agent}</span> {item.text}
      </div>
      <span className="when">{item.when}</span>
    </div>
  )
}

function TaskRow(props: { readonly task: RecentTask }): JSX.Element {
  const { task } = props
  const stateLabel =
    task.state === 'run' ? 'running' : task.state === 'queue' ? 'queued' : 'done'
  return (
    <div className="task" data-testid="mission-task-row">
      <span className="agent">{task.agent}</span>
      <div>
        <div className="title">{task.title}</div>
        <div className="meta">{task.meta}</div>
      </div>
      <span className={`state ${task.state}`}>{stateLabel}</span>
    </div>
  )
}

export function MissionRail(): JSX.Element {
  const feed = useActivityFeed(8)
  const tasks = useRecentTasks(5)

  return (
    <aside className="rail" data-testid="mission-rail">
      <section className="panel">
        <h3>
          Live activity <span className="sub">last 60m</span>
        </h3>
        {feed.data.length === 0 ? (
          <div className="feed-empty">
            Operator activity feed wires up with the upcoming
            daemon-side SSE channel. Tasks + agent statuses update live
            below and across the fleet grid.
          </div>
        ) : (
          <div className="feed">
            {feed.data.map((item, i) => (
              <FeedItem key={i} item={item} />
            ))}
          </div>
        )}
      </section>
      <section className="panel">
        <h3>
          Tasks <span className="sub">{tasks.data.length} active</span>
        </h3>
        {tasks.isLoading && <div className="feed-empty">Loading tasks…</div>}
        {tasks.isError && (
          <div className="feed-empty" style={{ color: 'hsl(var(--danger))' }}>
            Failed to load tasks.
          </div>
        )}
        {!tasks.isLoading && !tasks.isError && tasks.data.length === 0 && (
          <div className="feed-empty">No active tasks across the fleet.</div>
        )}
        <div>
          {tasks.data.map((t) => (
            <TaskRow key={t.id} task={t} />
          ))}
        </div>
      </section>
    </aside>
  )
}

export default MissionRail
