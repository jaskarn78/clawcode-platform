import type { ConversationTurn } from "../../memory/conversation-types.js";
import type { Tier2Facts } from "../compact-extractors/types.js";
import type { ActiveStateBlock, BuildActiveStateInput } from "./types.js";

const RULE_PATTERN = /\brule:|standing rule|from now on|always|never\b/i;
const COMMITMENT_PATTERN = /(?:^|\s)(?:I[' ]?ll\b|I will\b|next:|TODO:)/i;
const DRIVE_FOLDER_PATTERN = /clients\/([A-Za-z0-9_-]+)\//g;
const CLIENT_NAME_TOKEN = /\bclients\/([A-Za-z0-9_-]+)\//;
const MAX_LINES = 50;

function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function extractPrimaryClient(operatorMessages: readonly string[]): string | null {
  for (let i = operatorMessages.length - 1; i >= 0; i--) {
    const msg = operatorMessages[i] ?? "";
    const m = CLIENT_NAME_TOKEN.exec(msg);
    if (m && m[1]) return m[1];
  }
  return null;
}

function extractInFlightTasks(
  assistantTurns: readonly ConversationTurn[],
): readonly string[] {
  const out: string[] = [];
  for (let i = assistantTurns.length - 1; i >= 0 && out.length < 5; i--) {
    const turn = assistantTurns[i];
    if (!turn) continue;
    const lines = turn.content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (COMMITMENT_PATTERN.test(trimmed)) {
        const clean = trimmed.replace(/^[-*]\s*/, "");
        if (!out.includes(clean)) out.push(clean);
        if (out.length >= 5) break;
      }
    }
  }
  return Object.freeze(out);
}

function extractStandingRulesToday(
  operatorMessages: readonly string[],
  operatorTurns: readonly ConversationTurn[],
  now: Date,
): readonly string[] {
  const out: string[] = [];
  for (const t of operatorTurns) {
    if (t.role !== "user") continue;
    const created = new Date(t.createdAt);
    if (Number.isNaN(created.getTime())) continue;
    if (!isSameLocalDate(created, now)) continue;
    if (RULE_PATTERN.test(t.content)) {
      const oneLine = t.content.split("\n").find((l) => RULE_PATTERN.test(l));
      out.push((oneLine ?? t.content).trim());
    }
  }
  for (const msg of operatorMessages) {
    if (RULE_PATTERN.test(msg) && !out.includes(msg.trim())) {
      out.push(msg.trim());
    }
  }
  return Object.freeze(out.slice(0, 10));
}

function extractDriveFolders(
  turns: readonly ConversationTurn[],
): readonly string[] {
  const seen = new Set<string>();
  for (const t of turns) {
    DRIVE_FOLDER_PATTERN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = DRIVE_FOLDER_PATTERN.exec(t.content)) !== null) {
      seen.add(`clients/${m[1]}/`);
      if (seen.size >= 10) break;
    }
    if (seen.size >= 10) break;
  }
  return Object.freeze([...seen]);
}

function extractLastAgentCommitments(
  assistantTurns: readonly ConversationTurn[],
): readonly string[] {
  return extractInFlightTasks(assistantTurns);
}

function capToFiftyLines(block: ActiveStateBlock): ActiveStateBlock {
  const fieldCounts = {
    inFlightTasks: block.inFlightTasks.length,
    standingRulesAddedToday: block.standingRulesAddedToday.length,
    driveFoldersTouched: block.driveFoldersTouched.length,
    lastOperatorMessages: block.lastOperatorMessages.length,
    lastAgentCommitments: block.lastAgentCommitments.length,
  };
  const fixedHeaderLines = 3;
  let total =
    fixedHeaderLines +
    fieldCounts.inFlightTasks +
    fieldCounts.standingRulesAddedToday +
    fieldCounts.driveFoldersTouched +
    fieldCounts.lastOperatorMessages +
    fieldCounts.lastAgentCommitments;
  if (total <= MAX_LINES) return block;

  let inFlight = block.inFlightTasks.slice();
  let rules = block.standingRulesAddedToday.slice();
  let folders = block.driveFoldersTouched.slice();
  let ops = block.lastOperatorMessages.slice();
  let commits = block.lastAgentCommitments.slice();

  const trimOrder: ReadonlyArray<() => boolean> = [
    () => (folders.length > 3 ? (folders.pop(), true) : false),
    () => (rules.length > 3 ? (rules.pop(), true) : false),
    () => (commits.length > 3 ? (commits.pop(), true) : false),
    () => (inFlight.length > 3 ? (inFlight.pop(), true) : false),
    () => (ops.length > 3 ? (ops.shift(), true) : false),
  ];

  while (total > MAX_LINES) {
    let trimmed = false;
    for (const trim of trimOrder) {
      if (trim()) {
        trimmed = true;
        total--;
        if (total <= MAX_LINES) break;
      }
    }
    if (!trimmed) break;
  }

  return Object.freeze({
    primaryClient: block.primaryClient,
    inFlightTasks: Object.freeze(inFlight),
    standingRulesAddedToday: Object.freeze(rules),
    driveFoldersTouched: Object.freeze(folders),
    lastOperatorMessages: Object.freeze(ops),
    lastAgentCommitments: Object.freeze(commits),
    generatedAt: block.generatedAt,
  });
}

function mergeWithTier2(
  heuristic: ActiveStateBlock,
  facts: Tier2Facts,
): ActiveStateBlock {
  const tier2PrimaryClient =
    facts.activeClients.length > 0 ? facts.activeClients[0] : null;

  const tier2Tasks = facts.inFlightTasks.map((t) =>
    t.state.length > 0 ? `${t.task} — ${t.state}` : t.task,
  );
  const mergedTasksSet = new Set<string>([
    ...tier2Tasks,
    ...heuristic.inFlightTasks,
  ]);
  const mergedTasks = Object.freeze([...mergedTasksSet].slice(0, 10));

  const tier2Rules = facts.standingRulesChanged.map((r) =>
    r.changedAt.length > 0 ? `${r.rule} @ ${r.changedAt}` : r.rule,
  );
  const mergedRulesSet = new Set<string>([
    ...tier2Rules,
    ...heuristic.standingRulesAddedToday,
  ]);
  const mergedRules = Object.freeze([...mergedRulesSet].slice(0, 10));

  const mergedDriveSet = new Set<string>([
    ...heuristic.driveFoldersTouched,
    ...facts.drivePathsTouched,
  ]);
  const mergedDrive = Object.freeze([...mergedDriveSet].slice(0, 10));

  return Object.freeze({
    primaryClient: tier2PrimaryClient ?? heuristic.primaryClient,
    inFlightTasks: mergedTasks,
    standingRulesAddedToday: mergedRules,
    driveFoldersTouched: mergedDrive,
    lastOperatorMessages: heuristic.lastOperatorMessages,
    lastAgentCommitments: heuristic.lastAgentCommitments,
    generatedAt: heuristic.generatedAt,
  });
}

export function buildActiveStateBlock(
  input: BuildActiveStateInput,
): ActiveStateBlock {
  const now = input.clock();
  const operatorTurns = input.recentAgentTurns.filter((t) => t.role === "user");
  const assistantTurns = input.recentAgentTurns.filter(
    (t) => t.role === "assistant",
  );

  const lastOperatorMessages = Object.freeze(
    input.recentOperatorMessages.slice(-3),
  );

  const primaryClient =
    extractPrimaryClient(input.recentOperatorMessages) ??
    extractPrimaryClient(operatorTurns.map((t) => t.content));

  const heuristicBlock: ActiveStateBlock = Object.freeze({
    primaryClient,
    inFlightTasks: extractInFlightTasks(assistantTurns),
    standingRulesAddedToday: extractStandingRulesToday(
      input.recentOperatorMessages,
      operatorTurns,
      now,
    ),
    driveFoldersTouched: extractDriveFolders(input.recentAgentTurns),
    lastOperatorMessages,
    lastAgentCommitments: extractLastAgentCommitments(assistantTurns),
    generatedAt: now.toISOString(),
  });

  const merged = input.tier2Facts
    ? mergeWithTier2(heuristicBlock, input.tier2Facts)
    : heuristicBlock;

  return capToFiftyLines(merged);
}
