/**
 * Phase 999.164 — fast-lane routing: which messages the quick lane may answer.
 *
 * Measured on the first three hours live across 8 agents (2026-09-23): every quick
 * answer whose text survives was wrong. "Should I add more miles to today's run?"
 * got generic advice that the agent's own training data contradicted minutes later;
 * "?" nudges got "what do you need help with?"; a fin-client answer skipped the
 * verification gate. The v1 gate was agent-blind — one global action-word regex, then
 * Haiku deciding alone whether it needed data it did not know this agent owns.
 *
 * Principle: the quick lane answers only STANDALONE messages that touch neither the
 * user's own situation nor anything this agent has tools for. A false "task" costs a
 * few seconds; a false "quick" costs a wrong answer. Obvious task messages are routed
 * here, before any bridge call, so they no longer pay a 4–13 s Haiku round trip first.
 *
 * The domain registry is the single source of the per-agent quick-lane map: an
 * agent's domains are derived from its MCP servers, skills and admin
 * flag, and `renderQuickLaneMap` prints what that means for routing.
 *
 * Pure module: no I/O.
 */

import type { ResolvedAgentConfig } from "../shared/types.js";
import { ruleSaysTask } from "./fast-lane.js";

// ─────────────────────────── the domain registry ───────────────────────────

export type DomainId =
  | "training"
  | "health"
  | "calendar-email"
  | "home"
  | "travel"
  | "markets"
  | "shopping"
  | "legal"
  | "messaging"
  | "mac"
  | "fleet"
  | "media"
  | "secrets"
  | "web"
  | "systems";

type DomainDef = {
  readonly id: DomainId;
  /** Plain words, used in the quick-lane prompt and the map. */
  readonly label: string;
  /** MCP server names; a trailing `*` matches a prefix. */
  readonly mcp?: readonly string[];
  /** Skill names; a trailing `*` matches a prefix. */
  readonly skills?: readonly string[];
  /** Owned by admin agents. */
  readonly admin?: boolean;
  /** Owned by every agent (live information, the agent's own machine and files). */
  readonly universal?: boolean;
  /** Regex source for the words that mean a message touches this domain. */
  readonly vocab: string;
};

const DOMAINS: readonly DomainDef[] = [
  {
    id: "training",
    label: "training, fitness & recovery data",
    mcp: ["strava", "strava-coach", "trainingpeaks", "garmin-coach"],
    skills: ["adaptive-coaching"],
    vocab:
      "runs?|running|ran|jog(s|ging)?|miles?|mileage|volume|load|km|\\d+k|pace|splits?|workouts?|train(ing)?|rides?|riding|bike|biking|cycling|spin|swim(s|ming)?|laps?|races?|race ?day|marathon|triathlon|tempo|intervals?|strides|long run|easy run|recovery|recover|rest day|taper(ing)?|sore(ness)?|legs|fitness|fatigue|freshness|tss|ctl|atl|tsb|ftp|watts?|zone ?\\d|z\\d|heart ?rate|hrv|vo2 ?max|cadence|elevation|strava|trainingpeaks|zwift|garmin|peloton|exercise|lift(ing)?|gym",
  },
  {
    id: "health",
    label: "food, weight, sleep & body data",
    mcp: ["health-db", "garmin-coach"],
    skills: ["meal-log", "adaptive-coaching"],
    vocab:
      "calories?|kcal|macros?|protein|carbs?|fats?|fiber|sugar|meals?|ate|eat(s|ing|en)?|food|breakfast|lunch|dinner|snacks?|drinks?|alcohol|beer|wine|weight|weigh(ed|s|t-?in)?|lbs?|pounds?|kg|body ?fat|bmi|sleep(ing)?|slept|nap|fasting|diet|hungry|appetite",
  },
  {
    id: "calendar-email",
    label: "calendar, email & documents",
    mcp: ["google-workspace*"],
    skills: ["calendar-task-scheduler", "meeting-prep", "meeting-debrief"],
    vocab:
      "calendar|meetings?|appointments?|agenda|schedul(e|ed|ing)|availability|invites?|events?|emails?|emailed|e-?mail|inbox|gmail|unread|google docs?|sheets?|spreadsheets?|drive",
  },
  {
    id: "home",
    label: "home, car & devices",
    mcp: ["smarthome"],
    vocab:
      "tesla|car|charg(e|ed|ing)|battery|range|a\\/?c|air ?con\\w*|thermostat|temp(erature)?|degrees|heater|heat|lights?|lamps?|fans?|garage|locks?|locked|unlock(ed)?|homebridge|powerwall|solar|bedroom|living room",
  },
  {
    id: "travel",
    label: "flights, hotels & trips",
    mcp: ["travel-mcp"],
    skills: ["trip-planner"],
    vocab:
      "flights?|fly(ing)?|flew|airlines?|airports?|hotels?|trips?|travel(l?ing)?|fares?|layovers?|itinerar(y|ies)|boarding|check-?in|tsa|passport|rental car|airbnb|vacation",
  },
  {
    id: "markets",
    label: "markets, portfolios & client data",
    mcp: ["finnhub", "acme-db", "acme-content"],
    skills: [
      "portfolio-snapshot",
      "acme-*",
      "kronos-forecast",
      "buy-the-dip-screener",
      "retirement-plan-generator",
      "tax-scenario-analyzer",
      "log-client-interaction",
      "client-onboarding-checklist",
    ],
    vocab:
      "stocks?|shares?|tickers?|markets?|portfolios?|positions?|holdings?|clients?|accounts?|aum|ira|roth|401\\(?k\\)?|rmd|dividends?|earnings|etfs?|funds?|bonds?|yields?|interest rates?|fed|s&p|nasdaq|dow|spy|qqq|schwab|riskalyze|rebalanc\\w*|allocation|gains?|losses|tax(es)?|crm|prospects?|leads?|invest\\w*",
  },
  {
    id: "shopping",
    label: "orders, prices & watchlists",
    mcp: ["playwright-shopping"],
    skills: ["shopping-*"],
    vocab:
      "orders?|ordered|deliver(y|ed|ies)|shipping|shipped|packages?|tracking|prices?|deals?|sale|discount|coupon|restock|in stock|out of stock|cart|checkout|buy|bought|purchas(e|ed)|returns?|returned|refund|amazon|costco|target|walmart|best buy|cheaper|worth it",
  },
  {
    id: "legal",
    label: "contracts, deals & legal research",
    mcp: ["courtlistener", "side-project-tasks"],
    skills: ["deal-diligence", "deal-docs", "docx-revisions", "estate-planning-docs", "side-project-tasks"],
    vocab:
      "contracts?|clauses?|agreements?|lease|nda|loi|term sheet|redlines?|revisions?|statutes?|case law|cases?|court|lawsuit|litigation|liabilit(y|ies)|indemni\\w+|escrow|closing|diligence|trusts?|estate|probate|beneficiar(y|ies)|deeds?|liens?|ucc|llc|cap table|equity|counsel|attorney|lawyer|legal",
  },
  {
    id: "messaging",
    label: "WhatsApp",
    mcp: ["whatsapp"],
    skills: ["whatsapp-send"],
    vocab: "whatsapp|text(ed|s)?|dms?|group chat|messaged",
  },
  {
    id: "mac",
    label: "Operator's Mac (screen and apps)",
    mcp: ["mac-remote-node"],
    vocab: "mac|macbook|laptop|screen|screenshot|desktop|peekaboo",
  },
  {
    id: "fleet",
    label: "the ClawCode fleet (agents, schedules, alerts)",
    skills: ["fleet-brief"],
    admin: true,
    vocab:
      "agents?|fleet|daemon|deploy(ed|ment)?|restart(ed)?|crons?|schedules?|jobs?|alerts?|incidents?|outage|uptime|clawdy|clawcode|discord|bot",
  },
  {
    id: "media",
    label: "image generation & transcription",
    mcp: ["fal-ai", "transcribe"],
    skills: ["reelforge", "new-reel*"],
    vocab:
      "images?|pictures?|photos?|draw|illustrat\\w*|logo|renders?|videos?|reels?|transcri\\w+|recordings?|audio|voicemail|podcast",
  },
  {
    id: "secrets",
    label: "passwords & credentials",
    mcp: ["1password"],
    vocab: "passwords?|logins?|credentials?|2fa|otp|api keys?|tokens?|vault",
  },
  {
    id: "web",
    label: "the web and live information",
    universal: true,
    vocab:
      "weather|forecast|rain(ing)?|snow(ing)?|news|headlines?|latest|breaking|who won|scores?|standings|traffic|open now|still open|election|polls?|trending|exchange rate",
  },
  {
    id: "systems",
    label: "its own machine, files and running jobs",
    universal: true,
    vocab:
      "files?|folders?|pdfs?|docx?|documents?|attachments?|reports?|drafts?|decks?|slides|notes|workspace|saved|servers?|logs?|errors?|crash(ed|es)?|build|repo|branch|commits?|pull request|prs?|merged?|tmux|ssh|docker|containers?|prod|staging|pipeline|disk|memory|cpu|status|progress",
  },
];

const DOMAIN_VOCAB: ReadonlyMap<DomainId, RegExp> = new Map(DOMAINS.map((d) => [d.id, new RegExp(`\\b(?:${d.vocab})\\b`, "i")]));

/** What the router needs to know about an agent. Built from ResolvedAgentConfig. */
export type AgentRoutingProfile = {
  readonly name: string;
  readonly mcpServers: readonly { readonly name: string; readonly description?: string }[];
  readonly skills: readonly string[];
  readonly admin?: boolean;
  /** Operator-curated extra words/phrases that always mean "task lane" for this agent. */
  readonly taskTopics?: readonly string[];
};

/** The routing view of a resolved agent config. */
export function routingProfileFromConfig(
  cfg: Pick<ResolvedAgentConfig, "name" | "mcpServers" | "skills" | "admin" | "fastLane">,
): AgentRoutingProfile {
  return {
    name: cfg.name,
    mcpServers: cfg.mcpServers,
    skills: cfg.skills,
    admin: cfg.admin,
    taskTopics: cfg.fastLane?.taskTopics,
  };
}

export type ResolvedDomain = {
  readonly id: DomainId;
  readonly label: string;
  /** Why the agent owns it: server/skill names, "training", "admin" or "every agent". */
  readonly sources: readonly string[];
};

function matchesName(name: string, patterns: readonly string[] | undefined): boolean {
  if (!patterns) return false;
  const n = name.toLowerCase();
  return patterns.some((p) => (p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p));
}

/** The domains an agent owns, in registry order. */
export function resolveAgentDomains(profile: AgentRoutingProfile): readonly ResolvedDomain[] {
  const out: ResolvedDomain[] = [];
  for (const d of DOMAINS) {
    const sources: string[] = [];
    if (d.universal) sources.push("every agent");
    for (const s of profile.mcpServers) if (matchesName(s.name, d.mcp)) sources.push(s.name);
    for (const s of profile.skills) if (matchesName(s, d.skills)) sources.push(`skill:${s}`);
    if (d.admin && profile.admin) sources.push("admin");
    if (sources.length > 0) out.push({ id: d.id, label: d.label, sources });
  }
  return out;
}

/** Operator `fastLane.taskTopics` → one case-insensitive whole-word regex (null when empty). */
export function compileTaskTopics(topics: readonly string[] | undefined): RegExp | null {
  const words = (topics ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+"));
  return new RegExp(`\\b(?:${escaped.join("|")})\\b`, "i");
}

// ─────────────────────────── the router ───────────────────────────

export type QuickRule = "social" | "open";
export type TaskRule = "context" | "answer" | "reply" | "action" | "personal" | "temporal" | "domain" | "topic";

export type RouteVerdict =
  | { readonly lane: "quick"; readonly rule: QuickRule }
  | { readonly lane: "task"; readonly rule: TaskRule; readonly domain?: DomainId; readonly matched?: string };

export type RouteInput = {
  /** The raw message text, trimmed. */
  readonly text: string;
  /** True when the message is a Discord reply to another message. */
  readonly isReply: boolean;
  readonly domains: readonly ResolvedDomain[];
  readonly taskTopics?: RegExp | null;
};

const PUNCTUATION_ONLY = /^[\s?!.…,;:~-]+$/;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}‍️]/gu;

/** Lowercase, emoji out, outer punctuation out, curly apostrophes straightened. */
function normalizeWhole(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(EMOJI, " ")
    .replace(/^[\s?!.…,;:~-]+|[\s?!.…,;:~-]+$/g, "")
    .replace(/\s+/g, " ");
}

const GREETINGS = "hi|hey|hello|hiya|yo|howdy|sup|what'?s up|wassup|good morning|morning|gm|good afternoon|good evening|evening|good night|night|gn|how are you|how are you doing|how'?s it going|how you doing|how r u";
const GRATITUDE = "thanks|thank you|thank u|thanks so much|thank you so much|thanks a lot|thanks a ton|ty|tysm|tyvm|thx|appreciate it|much appreciated|i appreciate it|cheers";
const LAUGHTER = "lol|lmao|lmfao|rofl|haha|hahaha|heh|hehe";
/** A vocative or filler after a greeting/thanks ("thanks clawdy", "hi there", "thanks again") — never a content word. */
const SOCIAL_TAIL = "(?: (?:clawdy|man|bro|buddy|bud|dude|mate|friend|pal|boss|team|all|everyone|guys|y'?all|again|anyway|though|so much|a lot|a ton|there))?";
/**
 * Whole message is a greeting, thanks or laughter. Any one word may follow a
 * thank-you ("thanks coach"); greetings take only the vocative list, so "morning
 * run?" is not a greeting.
 */
const SOCIAL = new RegExp(`^(?:(?:${GRATITUDE})(?: [a-z']+)?|(?:${GREETINGS}|${LAUGHTER})${SOCIAL_TAIL})$`);
const GREETING_ONLY = new RegExp(`^(?:${GREETINGS})${SOCIAL_TAIL}$`);

/**
 * Answer-shaped messages: confirmations, reactions and single choices. They answer
 * something the agent said — often a question or an offer the quick lane cannot see
 * (a scheduled restock proposal, an alert) — so "ok" is a yes until proven otherwise.
 */
const ANSWER =
  /^(?:yes|yep|yeah|yup|ya|yea|sure|sure thing|absolutely|definitely|of course|please|please do|yes please|do it|go ahead|go for it|proceed|send it|ship it|approved?|confirm(ed)?|correct|right|exactly|that'?s right|no|nope|nah|no thanks|not now|stop|cancel|never ?mind|wait|hold on|hold off|skip it|both|neither|ok|okay|k|kk|oki|okie|alright|all right|cool|nice|great|awesome|perfect|sweet|amazing|excellent|good|fine|sounds good|sounds great|got it|gotcha|understood|noted|makes sense|fair enough|will do|love it|love that|ok thanks|okay thanks|ok thank you|cool thanks|great thanks|perfect thanks|awesome thanks|(?:option )?(?:[a-d]|[1-9])|the (?:first|second|third|last) one|first|second|third)$/;

/** Nudges and bare references: they point at state the quick lane cannot see. */
const CONTEXT_WHOLE =
  /^(?:you tell me|u tell me|tell me|and|so|well|then|and then|so what|what|huh|hm+|really|seriously|why|why not|how|how so|which|which one|what now|now what|and now|what else|anything else|go on|continue|keep going|carry on|next|more|more please|again|try again|retry|status|update|any updates?|any news|news|progress|eta|still there|you there|are you there|ping|done|done yet|finished|all done|did it work|did that work|is it done|where are we|where were we|what happened|still working|still waiting|waiting|bump|this|that|it|these|those|this one|that one|here|there|same|same here|see above|look|see|thoughts|and\?|so\?)$/;
/** A short message that opens by continuing or pointing back ("what about…", "that's wrong"). */
const CONTEXT_LEAD = /^(?:and|but|so|also|plus|or|then|now|actually|what about|how about|what if|same (?:for|with)|ok so|okay so|this|that|it|these|those|they|he|she|them|there)\b/;
const CONTEXT_LEAD_MAX_CHARS = 80;

/**
 * 999.174 — a reference to options the agent listed earlier, anywhere in the message
 * and at any length: "option 1 and 2", "#2", "number 3", "the second one", "both of
 * them", "between 1 and 3". The answer lives in a message the quick lane cannot see.
 * Field miss 2026-09-23 (#shopping): "whats the height difference between option 1
 * and 2?" → quick lane → "I don't have that comparison visible to me."
 */
const OPTION_REF = new RegExp(
  [
    // "option 2", "options 1 and 3". A lone letter needs the pair form below:
    // "is a call option a derivative?" is ordinary English.
    "\\boptions? ?#? ?[1-9]\\b(?: ?(?:and|&|or|vs\\.?|versus|,) ?#? ?[1-9a-d]\\b)?",
    "\\boptions? [a-d] ?(?:and|&|or|vs\\.?|versus|,) ?(?:option )?[a-d]\\b",
    // "is #2 lighter", "than number 3", "#1 or #2" — not a ranking ("was #1 in 1985",
    // "the most #1 hits"), so a lone #1 never counts.
    "\\b(?:is|was|does|did|would|will|can|about|for|than|and|or|vs\\.?|pick|take|get|with) (?:#|number )[2-9]\\b",
    "(?:#|\\bnumber )[1-9] ?(?:and|&|or|vs\\.?|versus) ?(?:#|number )?[1-9]\\b",
    // "first/last/other one" are too common in general questions to count, and so
    // is "the second one to walk on the moon".
    "\\b(?:second|third|fourth|fifth) one\\b(?! to\\b)",
    "\\bthe (?:former|latter)\\b",
    "\\b(?:both|either|neither) (?:of )?(?:them|these|those|options|ones)\\b",
    // Not "the two": "the three branches of government" is general knowledge.
    "\\b(?:those|these) (?:two|three|four)\\b",
    // Options run 1-4; "between 1 and 9/10" is a scale question.
    "\\bbetween (?:#?[1-4] (?:and|&) #?[1-4]\\b|them|these|those|the options)",
  ].join("|"),
  "i",
);

/** About the user: first person, singular or plural. Curly apostrophes count. */
const PERSONAL = /\b(?:i|i'm|im|i've|ive|i'd|i'll|me|my|mine|myself|we|we're|our|ours|ourselves)\b/i;

/** Anchored to now: the right answer changes with live state. */
const TEMPORAL =
  /\b(?:today|today'?s|todays|tonight|tonight'?s|tomorrow|tomorrow'?s|yesterday|yesterday'?s|this (?:morning|afternoon|evening|week|weekend|month|year)|next (?:week|weekend|month|year|time)|last (?:night|week|weekend|month|year)|now|currently|at the moment|lately|recently|so far|these days|upcoming|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekend|\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2}|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? \d{1,2})\b/i;

/**
 * Route one message. The first matching rule wins; `quick` means "the quick lane may
 * try" — the quick answer can still bail with NEEDS_TASK_LANE.
 */
export function routeQuickLane(input: RouteInput): RouteVerdict {
  const raw = input.text.replace(/[’‘]/g, "'").trim();
  if (PUNCTUATION_ONLY.test(raw)) return { lane: "task", rule: "context", matched: raw };
  const whole = normalizeWhole(raw);
  // An emoji-only message is a reaction ("👍"): answer-shaped.
  if (whole.length === 0) return { lane: "task", rule: "answer", matched: raw };
  if (SOCIAL.test(whole)) {
    // "hello?" after a silence is a nudge, not a greeting.
    if (raw.endsWith("?") && GREETING_ONLY.test(whole) && !/^how|^what/.test(whole)) {
      return { lane: "task", rule: "context", matched: raw };
    }
    return { lane: "quick", rule: "social" };
  }
  if (ANSWER.test(whole)) return { lane: "task", rule: "answer", matched: whole };
  if (CONTEXT_WHOLE.test(whole)) return { lane: "task", rule: "context", matched: whole };
  if (raw.length <= CONTEXT_LEAD_MAX_CHARS) {
    const lead = CONTEXT_LEAD.exec(whole);
    if (lead) return { lane: "task", rule: "context", matched: lead[0] };
  }
  const ref = OPTION_REF.exec(raw);
  if (ref) return { lane: "task", rule: "context", matched: ref[0] };
  if (input.isReply) return { lane: "task", rule: "reply" };
  if (ruleSaysTask(raw)) return { lane: "task", rule: "action" };
  const personal = PERSONAL.exec(raw);
  if (personal) return { lane: "task", rule: "personal", matched: personal[0] };
  const temporal = TEMPORAL.exec(raw);
  if (temporal) return { lane: "task", rule: "temporal", matched: temporal[0] };
  for (const d of input.domains) {
    const hit = DOMAIN_VOCAB.get(d.id)?.exec(raw);
    if (hit) return { lane: "task", rule: "domain", domain: d.id, matched: hit[0] };
  }
  const topic = input.taskTopics?.exec(raw);
  if (topic) return { lane: "task", rule: "topic", matched: topic[0] };
  return { lane: "quick", rule: "open" };
}

// ─────────────────────────── prompt digest + the map ───────────────────────────

/**
 * One line per owned domain, for the quick-lane prompt: what the agent's full session
 * can see that this lane cannot.
 */
export function renderDomainDigest(domains: readonly ResolvedDomain[]): string {
  return domains
    .map((d) => {
      const named = d.sources.filter((s) => s !== "every agent");
      return `- ${d.label}${named.length > 0 ? ` (${named.join(", ")})` : ""}`;
    })
    .join("\n");
}

/** Markdown section describing one agent's quick-lane routing — the audit map. */
export function renderQuickLaneMap(args: {
  readonly profile: AgentRoutingProfile;
  readonly enabled: boolean;
  readonly verificationEnforced: boolean;
}): string {
  const { profile } = args;
  const domains = resolveAgentDomains(profile);
  const owned = domains.filter((d) => !d.sources.includes("every agent"));
  const lines = [`### ${profile.name}`];
  if (!args.enabled) lines.push("- **Quick lane:** off — every message takes the full turn.");
  else lines.push("- **Quick lane answers:** greetings, thanks, laughter, and standalone general-knowledge questions that avoid everything below.");
  lines.push(
    `- **Always the full turn — domains this agent owns:** ${owned.length > 0 ? owned.map((d) => `${d.label} (${d.sources.join(", ")})`).join("; ") : "none beyond the universal ones"}.`,
  );
  lines.push(
    "- **Always the full turn, every agent:** confirmations and reactions (yes, ok, do it), nudges and bare references (?, this, you tell me), references to options listed earlier (option 1 and 2, #2, the second one), Discord replies, explicit work, anything about the user (I, my, we), anything anchored to now (today, tomorrow, weekdays, times), live information, files and running jobs.",
  );
  if (profile.taskTopics && profile.taskTopics.length > 0) lines.push(`- **Operator task topics:** ${profile.taskTopics.join(", ")}.`);
  if (args.enabled && args.verificationEnforced) {
    lines.push("- ⚠️ Financial verification is enforced here and only runs on the full turn: quick answers go out unverified. The domains above keep financial questions on the full turn.");
  }
  return lines.join("\n");
}
