/**
 * Phase 116-postdeploy 2026-05-12 — GSD planning artefacts surfaced on
 * the Tasks Kanban (Backlog + Running columns).
 *
 * The Tasks page Kanban currently shows only daemon-task records (the
 * `TaskStore` / `list-tasks-kanban` surface — operator-issued chained
 * delegations). Operators wanted actual pending work — `.planning/todos`,
 * non-shipped phases from `.planning/ROADMAP.md`, and in-flight
 * `.planning/quick/*` directories — to appear alongside, so the Backlog
 * column reflects the real workstream rather than only chain-routed
 * delegations.
 *
 * This module SCANS the repository's `.planning/` tree at request time
 * and returns a stable virtual-task shape. Source of truth stays on
 * disk; planning tasks are READ-ONLY in the dashboard — they can't be
 * drag-transitioned (operators manage them via the GSD CLI commands).
 *
 * Working-directory contract:
 *   - Dev daemon runs from this repo; `.planning/` exists.
 *   - Prod daemon runs from `/opt/clawcode`; `.planning/` does NOT exist.
 *     In that case every scanner returns empty arrays. The IPC handler
 *     swallows ENOENT — prod's Tasks page sees `sourceCount = {0,0,0}`
 *     and the existing daemon-task lanes carry on unchanged.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export type PlanningTaskStatus =
  | "pending"
  | "running"
  | "complete"
  | "failed";

export type PlanningTaskSource = "todo" | "phase" | "quick";

export type PlanningTask = {
  readonly id: string;
  readonly source: PlanningTaskSource;
  readonly title: string;
  readonly description?: string;
  readonly status: PlanningTaskStatus;
  readonly tags: readonly string[];
  readonly createdAt?: string;
  readonly filePath?: string;
  /**
   * Phase 116-postdeploy 2026-05-12 — short clarifier rendered as a
   * subtitle on each Kanban card. Disambiguates planning "in progress"
   * (e.g., PARTIAL phase = dominant fix shipped, edge cases pending)
   * from actual live agent execution.
   */
  readonly subtitle?: string;
};

export type PlanningTasksResponse = {
  readonly tasks: readonly PlanningTask[];
  readonly sourceCount: {
    readonly todo: number;
    readonly phase: number;
    readonly quick: number;
  };
};

/**
 * Parse simple YAML frontmatter at the top of a Markdown document.
 * Returns `null` if no frontmatter delimiters found. Tolerant of CRLF
 * and trailing whitespace.
 */
function extractFrontmatter(
  raw: string,
): { readonly frontmatter: Record<string, unknown>; readonly body: string } | null {
  // Frontmatter must start at byte 0 with `---\n` or `---\r\n`.
  if (!raw.startsWith("---")) return null;
  const after = raw.slice(3).replace(/^\r?\n/, "");
  const endIdx = after.search(/\n---\s*(\r?\n|$)/);
  if (endIdx === -1) return null;
  const yamlBlock = after.slice(0, endIdx);
  const body = after.slice(endIdx).replace(/^\n---\s*(\r?\n)?/, "");
  try {
    const parsed = parseYaml(yamlBlock);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { frontmatter: parsed as Record<string, unknown>, body };
    }
  } catch {
    // Malformed frontmatter — surface the file body as-is and skip.
    return null;
  }
  return null;
}

function firstParagraphAfterHeader(body: string): string | undefined {
  // Strip the markdown header (if present), then return the first
  // non-empty paragraph trimmed to a single line for compact display.
  const stripped = body.replace(/^#+\s+[^\n]*\n+/, "");
  const para = stripped.split(/\n\s*\n/)[0]?.trim();
  if (!para) return undefined;
  // Collapse whitespace so the card preview stays readable.
  return para.replace(/\s+/g, " ");
}

function extractSection(body: string, sectionHeader: string): string | undefined {
  // Find a `## <sectionHeader>` block and return its body up to the next
  // `## ` header. Case-insensitive on the header text.
  const re = new RegExp(
    `^##\\s+${sectionHeader.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\n([\\s\\S]*?)(?:\\n##\\s+|$)`,
    "im",
  );
  const m = body.match(re);
  if (!m) return undefined;
  const text = m[1]?.trim();
  if (!text) return undefined;
  return text.replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Scanner 1 — .planning/todos/*.md (excluding done/ subdir).
// Each top-level file is one Backlog task.
// ---------------------------------------------------------------------------

async function scanTodos(planningRoot: string): Promise<PlanningTask[]> {
  const dir = join(planningRoot, "todos");
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const tasks: PlanningTask[] = [];
  for (const name of entries) {
    if (!name.endsWith(".md")) continue;
    const filePath = join(dir, name);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = extractFrontmatter(raw);
    const fm = parsed?.frontmatter ?? {};
    const body = parsed?.body ?? raw;
    const title =
      (typeof fm.title === "string" && fm.title) || name.replace(/\.md$/, "");
    const description =
      extractSection(body, "Symptom") ?? firstParagraphAfterHeader(body);
    const severity = typeof fm.severity === "string" ? fm.severity : undefined;
    const area = typeof fm.area === "string" ? fm.area : undefined;
    const tags: string[] = ["todo"];
    if (severity) tags.push(`sev:${severity}`);
    if (area) tags.push(area);
    const createdAt =
      typeof fm.created === "string"
        ? fm.created
        : st.mtime.toISOString();
    tasks.push({
      id: `todo:${name.replace(/\.md$/, "")}`,
      source: "todo",
      title,
      description,
      status: "pending",
      tags,
      createdAt,
      filePath,
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Scanner 2 — .planning/ROADMAP.md non-shipped phases.
// ---------------------------------------------------------------------------

type PhaseStatus = "pending" | "running" | "shipped" | "other";

function classifyPhaseHeader(
  header: string,
): { readonly title: string; readonly status: PhaseStatus; readonly statusLabel: string } {
  // Match the trailing `(STATUS …)` if present.
  const trail = header.match(/\(([^)]+)\)\s*$/);
  const statusLabel = trail ? trail[1]!.trim() : "";
  const title = trail
    ? header.slice(0, header.length - trail[0].length).trim()
    : header.trim();
  const upper = statusLabel.toUpperCase();
  // Order matters: SHIPPED / CLOSED / PROMOTED / REPLACED dominate over
  // the active-sounding keywords because they're terminal.
  if (
    upper.startsWith("SHIPPED") ||
    upper.startsWith("CLOSED") ||
    upper.startsWith("PROMOTED") ||
    upper.startsWith("REPLACED") ||
    upper.startsWith("DEFERRED")
  ) {
    return { title, status: "shipped", statusLabel };
  }
  if (upper.startsWith("ACTIVE") || upper.startsWith("PARTIAL")) {
    return { title, status: "running", statusLabel };
  }
  if (upper.startsWith("BACKLOG") || upper.startsWith("PLANNED")) {
    return { title, status: "pending", statusLabel };
  }
  // No status parens — treat as "other" (skipped: there are descriptive
  // phase entries with no status hint, mostly shipped-by-implication).
  return { title, status: "other", statusLabel };
}

async function scanRoadmap(planningRoot: string): Promise<PlanningTask[]> {
  const file = join(planningRoot, "ROADMAP.md");
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return [];
  }
  const tasks: PlanningTask[] = [];
  // Walk the file line-by-line so we can capture each phase's body.
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^### Phase\s+([0-9.]+):\s*(.+)$/);
    if (!m) continue;
    const phaseNumber = m[1]!;
    const headerRest = m[2]!;
    const { title, status, statusLabel } = classifyPhaseHeader(headerRest);
    if (status === "shipped" || status === "other") continue;
    // Capture the body — lines until the next ### header or two blank lines.
    const bodyLines: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const ln = lines[j]!;
      if (/^### /.test(ln)) break;
      if (/^##\s+/.test(ln)) break;
      bodyLines.push(ln);
    }
    const body = bodyLines.join("\n").trim();
    const description = body
      ? body.split(/\n\s*\n/)[0]?.replace(/\s+/g, " ").trim()
      : undefined;
    const tags = [`phase-${phaseNumber}`];
    if (statusLabel) tags.push(statusLabel.split(/\s+/)[0]!.toLowerCase());
    // Per-source disclosure: clarify what the planning-task status really
    // means so operators don't conflate it with daemon-side `running`.
    const upper = statusLabel.toUpperCase();
    const subtitle = upper.startsWith("PARTIAL")
      ? "Partial — dominant fix shipped, edge cases pending"
      : upper.startsWith("ACTIVE")
      ? "Active — promoted to current milestone, not yet executing"
      : upper.startsWith("BACKLOG")
      ? "Backlog — queued in the roadmap, not yet started"
      : upper.startsWith("PLANNED")
      ? "Planned — scheduled in the roadmap, not yet started"
      : undefined;
    // Phase 116-postdeploy 2026-05-12 (revision) — every non-SHIPPED phase
    // surfaces under `status: "pending"` regardless of its roadmap-internal
    // state (PARTIAL/ACTIVE/BACKLOG/PLANNED). The previous mapping bled
    // PARTIAL+ACTIVE phases into the "In Progress" Kanban column, which
    // operators conflated with live agent execution. Planning metadata is
    // NOT live execution; the daemon's own `running` column is reserved for
    // truly-executing daemon tasks now. The subtitle field still discloses
    // the underlying status (Partial / Active / Backlog / Planned) so the
    // operator can tell the difference within the Backlog column.
    tasks.push({
      id: `phase:${phaseNumber}`,
      source: "phase",
      title: `Phase ${phaseNumber}: ${title}`,
      description,
      status: "pending",
      tags,
      filePath: file,
      subtitle,
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Scanner 3 — .planning/quick/*/ directories without SUMMARY.md.
// ---------------------------------------------------------------------------

async function scanQuickDirs(planningRoot: string): Promise<PlanningTask[]> {
  const root = join(planningRoot, "quick");
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const tasks: PlanningTask[] = [];
  for (const dirName of entries) {
    const dirPath = join(root, dirName);
    let st;
    try {
      st = await stat(dirPath);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    // Look for the PLAN file (named `<slug>-PLAN.md`); detect SUMMARY similarly.
    let children: string[];
    try {
      children = await readdir(dirPath);
    } catch {
      continue;
    }
    const planFile = children.find((c) => /-PLAN\.md$/i.test(c));
    const summaryFile = children.find((c) => /-SUMMARY\.md$/i.test(c));
    if (!planFile) continue; // not a real quick task yet

    if (summaryFile) {
      // Completed quick tasks — surface as Done if modified within the
      // last 7 days. This is the optional "recent completions" pass.
      const summaryStat = await stat(join(dirPath, summaryFile)).catch(
        () => null,
      );
      if (!summaryStat) continue;
      const ageMs = Date.now() - summaryStat.mtimeMs;
      if (ageMs > 7 * 24 * 3600 * 1000) continue;
      const filePath = join(dirPath, planFile);
      let raw: string;
      try {
        raw = await readFile(filePath, "utf-8");
      } catch {
        continue;
      }
      const parsed = extractFrontmatter(raw);
      const fm = parsed?.frontmatter ?? {};
      const title =
        (typeof fm.title === "string" && fm.title) ||
        dirName.replace(/^\d+-[a-z0-9]+-/i, "");
      tasks.push({
        id: `quick:${dirName}`,
        source: "quick",
        title,
        description: firstParagraphAfterHeader(parsed?.body ?? raw),
        status: "complete",
        tags: ["quick", "complete"],
        createdAt: summaryStat.mtime.toISOString(),
        filePath,
      });
      continue;
    }

    // In-flight quick task (PLAN.md but no SUMMARY.md).
    // Phase 116-postdeploy 2026-05-12 (revision) — drafted quicks surface as
    // `status: "pending"` so they live in the Backlog column. They are NOT
    // actively executing — a quick task with a PLAN but no SUMMARY just
    // means "operator wrote the plan, executor hasn't run yet." The
    // subtitle still discloses that state for operators who care.
    const filePath = join(dirPath, planFile);
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const parsed = extractFrontmatter(raw);
    const fm = parsed?.frontmatter ?? {};
    const body = parsed?.body ?? raw;
    const title =
      (typeof fm.title === "string" && fm.title) ||
      dirName.replace(/^\d+-[a-z0-9]+-/i, "");
    const description = firstParagraphAfterHeader(body);
    const planStat = await stat(filePath).catch(() => null);
    tasks.push({
      id: `quick:${dirName}`,
      source: "quick",
      title,
      description,
      status: "pending",
      tags: ["quick"],
      createdAt: planStat?.mtime.toISOString(),
      filePath,
      subtitle: "Quick task drafted, no executor invoked yet",
    });
  }
  return tasks;
}

// ---------------------------------------------------------------------------
// Public IPC entry point.
// ---------------------------------------------------------------------------

/**
 * Resolve the planning root relative to process.cwd() and run the three
 * scanners in parallel. Missing `.planning/` (production install) returns
 * the empty response — never errors. Per-scanner failures degrade
 * gracefully (logged at the call site if desired).
 */
export async function listPlanningTasks(opts?: {
  readonly cwd?: string;
}): Promise<PlanningTasksResponse> {
  const planningRoot = join(opts?.cwd ?? process.cwd(), ".planning");
  try {
    await stat(planningRoot);
  } catch {
    return { tasks: [], sourceCount: { todo: 0, phase: 0, quick: 0 } };
  }
  const [todos, phases, quicks] = await Promise.all([
    scanTodos(planningRoot).catch(() => [] as PlanningTask[]),
    scanRoadmap(planningRoot).catch(() => [] as PlanningTask[]),
    scanQuickDirs(planningRoot).catch(() => [] as PlanningTask[]),
  ]);
  // Stable ordering: phases first (work the project is committed to),
  // then quick (in-flight), then todos (signal but not yet committed),
  // then completed quicks (Done column). Within each group, recent first.
  const byTime = (a: PlanningTask, b: PlanningTask): number => {
    const at = a.createdAt ? Date.parse(a.createdAt) : 0;
    const bt = b.createdAt ? Date.parse(b.createdAt) : 0;
    return bt - at;
  };
  // Phase 116-postdeploy 2026-05-12 (revision) — after the mapping change
  // above, in-flight quicks emit `status: "pending"` (they're not actually
  // running). Partition by !complete so drafted quicks stay in the
  // response; previously the running-only filter would silently drop them.
  const phasesSorted = [...phases].sort(byTime);
  const quicksInflight = quicks
    .filter((q) => q.status !== "complete")
    .sort(byTime);
  const quicksDone = quicks.filter((q) => q.status === "complete").sort(byTime);
  const todosSorted = [...todos].sort(byTime);

  return {
    tasks: [...phasesSorted, ...quicksInflight, ...todosSorted, ...quicksDone],
    sourceCount: {
      todo: todos.length,
      phase: phases.length,
      quick: quicks.length,
    },
  };
}
