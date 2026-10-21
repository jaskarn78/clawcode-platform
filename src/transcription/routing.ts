/**
 * 999.143 — decide which agent owns a transcription job.
 *
 * Normally the tree IS the owner: a job under `client-a-personal`'s tree belongs to
 * client-a-personal. But one tree is shared by convention — side-project submits into
 * acme's tree with a `side-project-` job prefix — so the job id has to be
 * consulted before the tree, or side-project's transcripts land in
 * fin-client's channel.
 *
 * Prefix rules win over tree rules precisely because they are the exception.
 */
export type RoutingRules = {
  /** tree name -> agent. */
  readonly byTree: ReadonlyMap<string, string>;
  /** job-id prefix -> agent, checked FIRST. */
  readonly byJobPrefix?: ReadonlyMap<string, string>;
};

export function resolveAgent(rules: RoutingRules, tree: string, job: string): string | undefined {
  const lower = job.toLowerCase();
  for (const [prefix, agent] of rules.byJobPrefix ?? []) {
    if (lower.startsWith(prefix.toLowerCase())) return agent;
  }
  return rules.byTree.get(tree);
}
