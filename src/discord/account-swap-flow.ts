/**
 * Phase 999.176 — `/clawcode-account`: the Discord side of the fleet
 * account swap. Every credential decision lives in AccountService; this
 * file only moves the operator through the screens:
 *
 *   status ─[Switch to X]→ checking… ─ok→ confirm ─[Switch + restart]→ restart
 *                                   └─fail→ login (Mac attempt ‖ Enter code) ─┘
 *
 * All screens edit ONE ephemeral message and the code arrives via a modal,
 * so neither the link nor the code is posted to the channel by this flow.
 * (The Mac agent's own turn runs in the admin agent's session; it never sees
 * the link in its instruction — it reads it from the daemon.)
 * Buttons carry a per-flow nonce and are consumed with collectors scoped to
 * the message and the invoking user, so no global router change is needed.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Message,
  type ModalSubmitInteraction,
} from "discord.js";
import { randomBytes } from "node:crypto";
import type { AccountService } from "../account/account-service.js";
import { summarizeCredentialFile, activePath, type CredentialSummary } from "../account/credential-slots.js";
import type { LoginOutcome, LoginSession } from "../account/oauth-cli.js";
import { buildMacLoginInstruction, classifyMacReply } from "../account/mac-login-instruction.js";
import type { SwapBootResult } from "../account/pending-swap.js";
import {
  formatTier,
  renderBootReport,
  renderConfirm,
  renderLogin,
  renderStatus,
  type MacLine,
} from "./account-swap-render.js";

const PICK_TTL_MS = 5 * 60_000;
const MODAL_TTL_MS = 5 * 60_000;
const REPORT_BUTTON_TTL_MS = 60 * 60_000;
const MAC_REPLY_TIMEOUT_MS = 8 * 60_000;

export type AccountFlowLog = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
};

export type AccountFlowDeps = {
  readonly service: AccountService;
  readonly isAdmin: (i: { readonly user: { readonly id: string }; readonly channelId: string }) => boolean;
  readonly listRunningAgents: () => readonly string[];
  readonly hasActiveTurn: (agent: string) => boolean;
  /**
   * Hand a turn to the Mac-capable admin agent and resolve with its reply;
   * null when no such agent is running (manual path only).
   */
  readonly dispatchMacLogin:
    | ((instruction: string, correlationId: string, timeoutMs: number) => Promise<string>)
    | null;
  readonly log: AccountFlowLog;
  readonly now?: () => number;
};

type Editable = ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
type Payload = { content: string; components: ActionRowBuilder<ButtonBuilder>[] };

/** The interaction whose token currently owns the ephemeral message. */
class Surface {
  constructor(
    private current: Editable,
    readonly message: Message,
    readonly userId: string,
    readonly channelId: string,
  ) {}

  use(i: Editable): void {
    this.current = i;
  }

  async show(payload: Payload): Promise<void> {
    try {
      await this.current.editReply(payload);
    } catch {
      /* token expired (15 min) — the flow ends silently rather than crashing the daemon */
    }
  }
}

const btn = (id: string, label: string, style: ButtonStyle): ButtonBuilder =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

const row = (...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> =>
  new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

/** Wait for one click on `ids` by `userId`. Resolves null on timeout or stop(). */
function nextClick(
  message: Message,
  ids: readonly string[],
  userId: string,
  timeMs: number,
): { readonly promise: Promise<ButtonInteraction | null>; readonly stop: () => void } {
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.user.id === userId && ids.includes(i.customId),
    time: timeMs,
    max: 1,
  });
  const promise = new Promise<ButtonInteraction | null>((resolve) => {
    collector.once("end", (collected) => resolve(collected.first() ?? null));
  });
  return { promise, stop: () => collector.stop() };
}

const nonce = (): string => randomBytes(6).toString("hex");

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** `/clawcode-account` — admin gate, then the status screen. */
export async function runAccountCommand(
  interaction: ChatInputCommandInteraction,
  deps: AccountFlowDeps,
): Promise<void> {
  if (!deps.isAdmin({ user: interaction.user, channelId: interaction.channelId })) {
    await interaction
      .reply({ content: "Admin-only command", flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const message = await interaction.fetchReply();
  const surface = new Surface(interaction, message, interaction.user.id, interaction.channelId);
  await statusScreen(surface, deps);
}

async function statusScreen(surface: Surface, deps: AccountFlowDeps): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const view = await deps.service.status();
  const n = nonce();
  const targets = view.configured.filter((c) => c.name !== view.activeSlot);
  const closeId = `acct:${n}:close`;
  const switchIds = new Map(targets.map((t) => [`acct:${n}:sw:${t.name}`, t.name]));
  const buttons = [
    ...[...switchIds].map(([id, name]) =>
      btn(id, `Switch to ${name}`, ButtonStyle.Primary).setDisabled(view.activeSlot === null),
    ),
    btn(closeId, "Close", ButtonStyle.Secondary),
  ];
  await surface.show({ content: renderStatus(view, now), components: [row(...buttons.slice(0, 5))] });

  const click = await nextClick(surface.message, [...switchIds.keys(), closeId], surface.userId, PICK_TTL_MS).promise;
  if (click === null || click.customId === closeId) {
    if (click) await click.deferUpdate().catch(() => {});
    if (click) surface.use(click);
    await surface.show({ content: renderStatus(view, now), components: [] });
    return;
  }
  await click.deferUpdate();
  surface.use(click);
  await switchFlow(surface, switchIds.get(click.customId)!, deps);
}

// ---------------------------------------------------------------------------
// Switch flow
// ---------------------------------------------------------------------------

async function switchFlow(surface: Surface, target: string, deps: AccountFlowDeps): Promise<void> {
  let slot;
  try {
    slot = deps.service.slotConfig(target);
  } catch (err) {
    await surface.show({ content: `⚠️ ${(err as Error).message}`, components: [] });
    return;
  }
  await surface.show({ content: `🔎 Checking the saved login for \`${target}\` (${slot.email})…`, components: [] });

  let pre;
  try {
    pre = await deps.service.preflight(target);
  } catch (err) {
    await surface.show({ content: `⚠️ ${(err as Error).message}`, components: [] });
    return;
  }
  if (pre.ok) {
    await confirmScreen(surface, target, pre.email ?? slot.email, pre.summary, false, deps, pre.email !== null);
    return;
  }
  if (pre.reason === "wrong-account") {
    // A slot holding the wrong account is exactly what a fresh login fixes.
    deps.log.warn({ component: "account-swap", target }, "saved slot holds the wrong account — forcing re-login");
  }
  await loginScreen(surface, target, slot.email, slot.opItem, pre.detail, deps);
}

async function loginScreen(
  surface: Surface,
  target: string,
  email: string,
  opItem: string | undefined,
  why: string,
  deps: AccountFlowDeps,
): Promise<void> {
  await surface.show({ content: `🔐 The saved login for \`${target}\` can't be used (${why}). Starting a new sign-in…`, components: [] });
  let session: LoginSession;
  try {
    session = await deps.service.startLogin(target);
  } catch (err) {
    await surface.show({ content: `⚠️ Couldn't start a sign-in: ${(err as Error).message}`, components: [] });
    return;
  }

  const n = nonce();
  const codeId = `acct:${n}:code`;
  const cancelId = `acct:${n}:cancel`;
  const modalId = `acct:${n}:modal`;
  let mac: MacLine = deps.dispatchMacLogin ? { kind: "trying" } : { kind: "none" };
  const render = (): Payload => ({
    content: renderLogin({ target, email, why, url: session.authorizeUrl, expiresAt: session.expiresAt, mac }),
    components: [row(btn(codeId, "Enter code", ButtonStyle.Primary), btn(cancelId, "Cancel", ButtonStyle.Secondary))],
  });
  await surface.show(render());

  if (deps.dispatchMacLogin) {
    const instruction = buildMacLoginInstruction({ email, opItem });
    void deps
      .dispatchMacLogin(instruction, `acct-login-${session.id}`, MAC_REPLY_TIMEOUT_MS)
      .then((reply) => classifyMacReply(reply))
      .catch((err: unknown) => ({ kind: "unavailable" as const, reason: err instanceof Error ? err.message : String(err) }))
      .then(async (r) => {
        if (!session.isOpen) return;
        mac = r.kind === "done" ? { kind: "done" } : { kind: "unavailable", reason: r.reason };
        await surface.show(render());
      });
  }

  // Code-entry loop: runs until the session settles (either source) or is cancelled.
  while (session.isOpen) {
    const waiter = nextClick(surface.message, [codeId, cancelId], surface.userId, Math.max(1_000, session.expiresAt - (deps.now ?? Date.now)()));
    const click = await Promise.race([waiter.promise, session.done.then(() => null)]);
    waiter.stop();
    if (click === null) break;
    if (click.customId === cancelId) {
      await click.deferUpdate().catch(() => {});
      surface.use(click);
      deps.service.cancelLogin(session.id);
      break;
    }
    const input = new TextInputBuilder()
      .setCustomId("code")
      .setLabel("Code from the sign-in page")
      .setStyle(TextInputStyle.Short)
      .setMinLength(8)
      .setMaxLength(1100)
      .setRequired(true);
    await click.showModal(
      new ModalBuilder().setCustomId(modalId).setTitle(`Sign in: ${target}`).addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(input),
      ),
    );
    const submit = await Promise.race([
      click
        .awaitModalSubmit({ filter: (s) => s.customId === modalId && s.user.id === surface.userId, time: MODAL_TTL_MS })
        .catch(() => null),
      session.done.then(() => null),
    ]);
    if (submit === null) continue;
    await submit.deferUpdate().catch(() => {});
    surface.use(submit);
    const res = await deps.service.submitCode(session.id, submit.fields.getTextInputValue("code"));
    if (!res.accepted) {
      await submit.followUp({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }

  const outcome: LoginOutcome = await session.done;
  deps.log.info({ component: "account-swap", target, status: outcome.status }, "account login finished");
  if (outcome.status === "succeeded") {
    await confirmScreen(surface, target, outcome.email, outcome.summary, true, deps, true);
    return;
  }
  await retryScreen(surface, target, `❌ Sign-in ${outcome.status}: ${outcome.detail}`, deps);
}

async function retryScreen(surface: Surface, target: string, text: string, deps: AccountFlowDeps): Promise<void> {
  const n = nonce();
  const retryId = `acct:${n}:retry`;
  const closeId = `acct:${n}:close`;
  await surface.show({
    content: text,
    components: [row(btn(retryId, "Try again", ButtonStyle.Primary), btn(closeId, "Close", ButtonStyle.Secondary))],
  });
  const click = await nextClick(surface.message, [retryId, closeId], surface.userId, PICK_TTL_MS).promise;
  if (click === null) {
    await surface.show({ content: text, components: [] });
    return;
  }
  await click.deferUpdate().catch(() => {});
  surface.use(click);
  if (click.customId === closeId) {
    await surface.show({ content: text, components: [] });
    return;
  }
  await switchFlow(surface, target, deps);
}

async function confirmScreen(
  surface: Surface,
  target: string,
  email: string,
  summary: CredentialSummary,
  freshLogin: boolean,
  deps: AccountFlowDeps,
  emailVerified: boolean,
): Promise<void> {
  const view = await deps.service.status();
  const running = deps.listRunningAgents();
  const busy = running.filter((a) => deps.hasActiveTurn(a));
  const n = nonce();
  const goId = `acct:${n}:go`;
  const cancelId = `acct:${n}:cancel`;
  const content = renderConfirm({
    target,
    email,
    summary,
    fromSlot: view.activeSlot,
    fromTier: formatTier(view.live),
    runningAgents: running.length,
    busyAgents: busy,
    freshLogin,
    emailVerified,
  });
  await surface.show({
    content,
    components: [row(btn(goId, "Switch + restart fleet", ButtonStyle.Danger), btn(cancelId, "Cancel", ButtonStyle.Secondary))],
  });
  const click = await nextClick(surface.message, [goId, cancelId], surface.userId, PICK_TTL_MS).promise;
  if (click === null || click.customId === cancelId) {
    if (click) {
      await click.deferUpdate().catch(() => {});
      surface.use(click);
    }
    await surface.show({ content: `${content}\n\n**Not switched.** The new login stays saved for next time.`, components: [] });
    return;
  }
  await click.update({ content: `♻️ Switching the fleet to \`${target}\` — restarting now. I'll post the result in this channel when it's back.`, components: [] });
  try {
    await deps.service.scheduleSwap({ target, requestedBy: surface.userId, channelId: surface.channelId });
    deps.log.info({ component: "account-swap", target, by: surface.userId }, "account swap scheduled — restarting daemon");
  } catch (err) {
    await click.editReply({ content: `⚠️ Switch not started: ${(err as Error).message}`, components: [] }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Post-boot report
// ---------------------------------------------------------------------------

export type BootReportExtras = {
  readonly client: Client;
  /** One real request through a fresh `claude` process on the live credential; null = skipped. */
  readonly probeAuth: () => Promise<boolean | null>;
};

/**
 * Post the swap result to the channel it was requested from, with a
 * Roll back button. Call once Discord is ready and agents have booted.
 */
export async function postSwapBootReport(
  result: SwapBootResult,
  deps: AccountFlowDeps,
  extras: BootReportExtras,
): Promise<void> {
  const now = (deps.now ?? Date.now)();
  const view = await deps.service.status();
  const live = await summarizeCredentialFile(activePath(view.configDir));
  const probeOk = result.ok && result.changed ? await extras.probeAuth() : null;
  const liveEmail = view.configured.find((c) => c.name === view.activeSlot)?.email ?? null;
  const content = renderBootReport({ result, live, liveEmail, probeOk, runningAgents: deps.listRunningAgents().length, now });

  const channel = await extras.client.channels.fetch(result.channelId);
  if (channel === null || !channel.isSendable()) {
    deps.log.warn({ component: "account-swap", channelId: result.channelId }, "swap report channel not sendable");
    return;
  }
  const rollbackTarget = result.ok && result.changed ? result.from : null;
  const rollbackId = `acct:${nonce()}:rollback`;
  const message = await channel.send({
    content,
    allowedMentions: { parse: [] },
    components: rollbackTarget ? [row(btn(rollbackId, `Roll back to ${rollbackTarget}`, ButtonStyle.Secondary))] : [],
  });
  if (!rollbackTarget) return;

  // Public message → any admin may roll back; each click gets its own ephemeral flow.
  const collector = message.createMessageComponentCollector({
    componentType: ComponentType.Button,
    filter: (i) => i.customId === rollbackId,
    time: REPORT_BUTTON_TTL_MS,
  });
  collector.on("collect", (click) => {
    void (async () => {
      if (!deps.isAdmin({ user: click.user, channelId: click.channelId })) {
        await click.reply({ content: "Admin-only.", flags: MessageFlags.Ephemeral }).catch(() => {});
        return;
      }
      await click.deferReply({ flags: MessageFlags.Ephemeral });
      const reply = await click.fetchReply();
      await switchFlow(new Surface(click, reply, click.user.id, click.channelId), rollbackTarget, deps);
    })().catch((err: unknown) =>
      deps.log.warn({ component: "account-swap", error: err instanceof Error ? err.message : String(err) }, "rollback flow failed"),
    );
  });
  collector.on("end", () => {
    void message.edit({ components: [] }).catch(() => {});
  });
}
