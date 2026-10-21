/**
 * 999.143 — watch the Unraid trees and drive the channel.
 *
 * Closes the loop the pipeline never had: today an agent must submit, then poll
 * inside the same turn, which ties a 40-minute recording to a single turn and
 * leaves the owner staring at nothing. This runs in the daemon instead, posts
 * ONE card per job, edits it as the job advances, and on completion delivers the
 * transcript and asks the agent to summarise it.
 *
 * The tree is the routing key: a job under `client-a-personal`'s tree can only reach
 * client-a-personal's channel. Misrouting would require misconfiguring the tree map,
 * not a bug in here.
 *
 * Every side effect is injected, so the state machine is tested without Discord,
 * SSH, or a daemon (see __tests__/watcher.test.ts).
 */
import type { Cv2Spec } from "../discord/cv2-renderer.js";
import { buildProgressCard } from "./card.js";
import { prime, reconcile, withMessageId, type Action, type Observed, type TrackedJob } from "./reconcile.js";

export type WatcherDeps = {
  /** One poll of every configured tree. */
  readonly poll: () => Promise<readonly Observed[]>;
  /**
   * Which agent owns this job. Takes the JOB as well as the tree because a tree
   * can be shared by convention — side-project submits into acme's tree with a
   * `side-project-` job prefix — and routing on the tree alone would deliver its
   * transcripts into fin-client's channel.
   * Returns undefined for an unowned tree, which is ignored loudly, once.
   */
  readonly agentFor: (tree: string, job: string) => string | undefined;
  readonly postCard: (agent: string, spec: Cv2Spec) => Promise<string | undefined>;
  readonly editCard: (agent: string, messageId: string, spec: Cv2Spec) => Promise<void>;
  /**
   * Fetch the finished transcript to a local path and hand it to the agent's
   * channel, then ask the agent to summarise it in its own words.
   */
  readonly deliver: (agent: string, tree: string, job: string) => Promise<void>;
  readonly log: {
    info(o: unknown, m?: string): void;
    warn(o: unknown, m?: string): void;
    error(o: unknown, m?: string): void;
  };
};

export class TranscriptionWatcher {
  private tracked: ReadonlyMap<string, TrackedJob> = new Map();
  private readonly unmappedWarned = new Set<string>();
  private running = false;
  private primed: boolean;
  private timer: NodeJS.Timeout | undefined;

  /**
   * `startPrimed` skips the cold-start adoption. Production always primes; tests
   * that are exercising steady-state behaviour opt out so they do not have to
   * burn a tick on it.
   */
  constructor(
    private readonly deps: WatcherDeps,
    private readonly intervalMs = 15_000,
    startPrimed = false,
  ) {
    this.primed = startPrimed;
  }

  start(): void {
    if (this.timer) return;
    // unref so a watcher tick can never hold the daemon open on shutdown.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
    this.deps.log.info({ intervalMs: this.intervalMs }, "transcription watcher started");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll + reconcile + act. Public so tests drive it deterministically. */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.running) return;      // a slow poll must not overlap the next tick
    this.running = true;
    try {
      const observed = await this.deps.poll();
      const routable = observed.filter((o) => {
        if (this.deps.agentFor(o.tree, o.job)) return true;
        if (!this.unmappedWarned.has(o.tree)) {
          this.unmappedWarned.add(o.tree);
          this.deps.log.warn({ tree: o.tree }, "transcription tree has no agent — ignoring its jobs");
        }
        return false;
      });

      // First tick: adopt what is already finished as history and act on none
      // of it. The output trees are an archive; replaying them would post cards
      // and re-deliver transcripts for work completed weeks ago.
      if (!this.primed) {
        this.primed = true;
        this.tracked = prime(routable);
        const adopted = this.tracked.size;
        this.deps.log.info(
          { adopted, live: routable.length - adopted },
          "transcription watcher primed — existing finished jobs adopted as history",
        );
        return;
      }

      const { actions, next } = reconcile(this.tracked, routable, now);
      this.tracked = next;
      for (const action of actions) await this.apply(action);
    } catch (err) {
      // A tick that throws must not kill the interval; the pipeline is fine and
      // the next tick will pick the job up again.
      this.deps.log.error(
        { err: err instanceof Error ? err.message : String(err) },
        "transcription watcher tick failed",
      );
    } finally {
      this.running = false;
    }
  }

  private async apply(action: Action): Promise<void> {
    const agent = this.deps.agentFor(action.tree, action.job);
    if (!agent) return;
    const fileName = action.job;

    try {
      if (action.kind === "post") {
        const spec = buildProgressCard({ state: action.state, fileName, queuePosition: action.queuePosition });
        const id = await this.deps.postCard(agent, spec);
        if (id) this.tracked = withMessageId(this.tracked, action.tree, action.job, id);
        return;
      }

      if (action.kind === "edit") {
        const spec = buildProgressCard({ state: action.state, fileName, queuePosition: action.queuePosition });
        await this.deps.editCard(agent, action.messageId, spec);
        return;
      }

      if (action.kind === "fail") {
        const spec = buildProgressCard({ state: { job: action.job, phase: "queued", pct: 0 }, fileName, failureReason: action.reason });
        if (action.messageId) await this.deps.editCard(agent, action.messageId, spec);
        else await this.deps.postCard(agent, spec);
        this.deps.log.error({ agent, tree: action.tree, job: action.job, reason: action.reason }, "transcription failed");
        return;
      }

      // complete — show the finished card FIRST so the card never sits mid-bar
      // while the transcript is being fetched, then deliver and summarise.
      const spec = buildProgressCard({ state: action.state, fileName });
      if (action.messageId) await this.deps.editCard(agent, action.messageId, spec);
      else await this.deps.postCard(agent, spec);
      await this.deps.deliver(agent, action.tree, action.job);
      this.deps.log.info({ agent, tree: action.tree, job: action.job }, "transcript delivered");
    } catch (err) {
      this.deps.log.warn(
        { agent, action: action.kind, job: action.job, err: err instanceof Error ? err.message : String(err) },
        "transcription watcher action failed",
      );
    }
  }
}
