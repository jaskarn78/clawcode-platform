/**
 * Phase 145 WS3 (Plan 07) — Slack-native interactive helpers (PURE).
 *
 * Slack delivers a Block Kit interaction (`block_actions`) over Socket Mode as
 * a distinct `type:"interactive"` envelope (NO nested `event`) — see
 * socket-mode.ts. This module is the pure boundary for that path:
 *
 *  - {@link buildSlackAskBlocks} renders an `ask_user_question` batch (≤4
 *    questions) as a Block Kit `blocks[]` — a section + an actions block per
 *    question (buttons for single-select, a `multi_static_select` for
 *    multiSelect) + a final Submit button. The action_id encodes the issued
 *    promptId + a SHORT positional question token (`pp:<promptId>:q<i>`),
 *    mirroring the Discord custom_id encoding (askQuestionDiscord) so the
 *    answer round-trips through the SAME positional translation. The optionId
 *    rides in the button `value` / multi-select `selected_options[].value`.
 *
 *  - {@link slackInteractiveToNeutralAnswer} parses an inbound interactive
 *    payload into a neutral answer + the answering user id (for the fail-closed
 *    allowlist check). It is ANTI-FORGERY: the action_id's promptId MUST match
 *    the issued promptId or it returns null (T-145-20). A malformed action_id,
 *    a missing user, or an out-of-range question token also return null. The
 *    Submit button resolves with `isSubmit:true` and no selection so the
 *    adapter knows to finalize.
 *
 * Both functions are pure (no I/O); the adapter (adapter.ts) owns the
 * promptId-keyed pending state + the SlackWebClient post.
 */

import type {
  NeutralAnswer,
  NeutralAnswers,
  NeutralQuestion,
} from "../types.js";

/** The positional token prefix that encodes (promptId, question) in action_ids. */
const ACTION_PREFIX = "pp";
/** The Submit button's positional token (mirrors askQuestionDiscord). */
export const SLACK_SUBMIT_TOKEN = "__submit__";

/** Slack text limits we defensively clamp to (Block Kit hard caps). */
const BUTTON_TEXT_MAX = 75;
const OPTION_TEXT_MAX = 75;
const SECTION_TEXT_MAX = 3000;
const ACTION_ID_MAX = 255;

/** A single action in a Slack `block_actions` payload (loosely typed). */
export type SlackInteractiveAction = {
  /** Encodes `pp:<promptId>:q<i>` (or the Submit token). */
  readonly action_id?: string;
  /** Single-select button: the chosen optionId. */
  readonly value?: string;
  /** Multi-static-select: the chosen optionIds. */
  readonly selected_options?: readonly { readonly value?: string }[];
  readonly [key: string]: unknown;
};

/**
 * A Slack interactive (`block_actions`) payload over Socket Mode. NO nested
 * `event` (that is the events_api shape). Loosely typed — we read only the
 * fields the parser needs.
 */
export type SlackInteractivePayload = {
  readonly type?: string;
  readonly user?: { readonly id?: string };
  readonly actions?: readonly SlackInteractiveAction[];
  readonly response_url?: string;
  readonly [key: string]: unknown;
};

/** Result of {@link slackInteractiveToNeutralAnswer}. */
export type SlackInteractiveResult = {
  /** The answering user's id (for the fail-closed allowlist check). */
  readonly userId: string;
  /** True when this was the Submit button (finalize the accumulated answers). */
  readonly isSubmit: boolean;
  /** The selection(s) carried by THIS payload (empty for a Submit click). */
  readonly answers: NeutralAnswers;
};

/** Compose the action_id for a question token. */
export function slackQuestionActionId(promptId: string, index: number): string {
  return `${ACTION_PREFIX}:${promptId}:q${index}`.slice(0, ACTION_ID_MAX);
}

/** Compose the Submit button's action_id. */
export function slackSubmitActionId(promptId: string): string {
  return `${ACTION_PREFIX}:${promptId}:${SLACK_SUBMIT_TOKEN}`.slice(0, ACTION_ID_MAX);
}

/**
 * Parse an action_id into (promptId, token). Returns null on any shape that is
 * not `pp:<promptId>:<token>` with both parts present.
 */
function parseActionId(
  actionId: string | undefined,
): { promptId: string; token: string } | null {
  if (typeof actionId !== "string") return null;
  // Split into at most 3 parts so a token can never absorb extra colons.
  const m = /^pp:([^:]+):(.+)$/.exec(actionId);
  if (!m) return null;
  return { promptId: m[1], token: m[2] };
}

/** A Block Kit block (loosely typed — we only assert structure in tests). */
export type SlackBlock = {
  readonly type: string;
  readonly [key: string]: unknown;
};

/**
 * Build the Block Kit `blocks[]` for an `ask_user_question` batch. Renders up
 * to 4 questions; each becomes a `section` (header + optional body) followed by
 * an `actions` block. Single-select → one `button` per option; multiSelect →
 * one `multi_static_select`. A final `actions` block holds the Submit button.
 *
 * action_id = `pp:<promptId>:q<i>` for questions, `pp:<promptId>:__submit__`
 * for Submit (mirrors askQuestionDiscord's positional custom_id). The optionId
 * rides in the button `value` / option `value`.
 */
export function buildSlackAskBlocks(
  promptId: string,
  questions: readonly NeutralQuestion[],
): SlackBlock[] {
  // Slack caps a message at ~50 blocks; with ≤4 questions (2 blocks each) +
  // submit we are far under. Cap at 4 to match the neutral batch ceiling.
  const capped = questions.slice(0, 4);
  const blocks: SlackBlock[] = [];

  capped.forEach((q, i) => {
    const multi = q.multiSelect ? "  _(select one or more)_" : "";
    const body = q.text ? `\n${q.text}` : "";
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${i + 1}. ${q.header}*${multi}${body}`.slice(0, SECTION_TEXT_MAX),
      },
    });

    if (q.multiSelect) {
      blocks.push({
        type: "actions",
        elements: [
          {
            type: "multi_static_select",
            action_id: slackQuestionActionId(promptId, i),
            placeholder: {
              type: "plain_text",
              text: "Select one or more",
            },
            options: q.options.map((o) => ({
              text: { type: "plain_text", text: o.label.slice(0, OPTION_TEXT_MAX) },
              value: o.id,
            })),
          },
        ],
      });
    } else {
      // Single-select → one button per option (Slack caps an actions block at
      // 25 elements; a question batch should already be ≤25).
      blocks.push({
        type: "actions",
        elements: q.options.slice(0, 25).map((o) => ({
          type: "button",
          action_id: slackQuestionActionId(promptId, i),
          text: { type: "plain_text", text: o.label.slice(0, BUTTON_TEXT_MAX) },
          value: o.id,
        })),
      });
    }
  });

  // Final Submit button (mirrors the Discord Submit affordance).
  blocks.push({
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: slackSubmitActionId(promptId),
        text: { type: "plain_text", text: "Submit" },
        style: "primary",
        value: SLACK_SUBMIT_TOKEN,
      },
    ],
  });

  return blocks;
}

/**
 * Parse a Slack interactive payload into a neutral answer + the answering user.
 * FAIL-CLOSED / ANTI-FORGERY:
 *  - the action_id's promptId MUST equal `issuedPromptId` (else null — T-145-20)
 *  - a missing/empty user id → null (cannot allowlist-check)
 *  - a malformed action_id → null
 *  - a question token (`q<i>`) outside the batch → null
 *
 * The Submit button (`__submit__`) returns `{ isSubmit:true, answers:{[]} }` so
 * the adapter finalizes the accumulated selections. A question button/select
 * returns the single selection for THAT question (the adapter accumulates).
 */
export function slackInteractiveToNeutralAnswer(
  payload: SlackInteractivePayload,
  issuedPromptId: string,
  questions: readonly NeutralQuestion[],
): SlackInteractiveResult | null {
  const userId = payload.user?.id;
  if (typeof userId !== "string" || userId.length === 0) return null;

  const action = payload.actions?.[0];
  const parsed = parseActionId(action?.action_id);
  if (!parsed) return null;
  // Anti-forgery: the click must carry OUR issued promptId.
  if (parsed.promptId !== issuedPromptId) return null;

  if (parsed.token === SLACK_SUBMIT_TOKEN) {
    return { userId, isSubmit: true, answers: { answers: [] } };
  }

  // Positional question token `q<i>` → the real questionId via the batch index.
  const tokenMatch = /^q(\d+)$/.exec(parsed.token);
  if (!tokenMatch) return null;
  const qIndex = Number.parseInt(tokenMatch[1], 10);
  const capped = questions.slice(0, 4);
  const question = capped[qIndex];
  if (!question) return null;

  const selectedOptionIds = extractSelectedOptionIds(action);
  if (selectedOptionIds.length === 0) return null;

  const answer: NeutralAnswer = {
    questionId: question.id,
    selectedOptionIds,
  };
  return { userId, isSubmit: false, answers: { answers: [answer] } };
}

/** Read the chosen optionId(s) from a button (value) or a multi-select. */
function extractSelectedOptionIds(
  action: SlackInteractiveAction | undefined,
): string[] {
  if (!action) return [];
  if (Array.isArray(action.selected_options)) {
    return action.selected_options
      .map((o) => o.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof action.value === "string" && action.value.length > 0) {
    return [action.value];
  }
  return [];
}
