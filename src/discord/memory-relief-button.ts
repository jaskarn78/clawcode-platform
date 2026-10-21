/**
 * 999.147 WS-2 — the Discord surface of the relief action.
 *
 * Splits deliberately in two:
 *   - `buildReliefRow` / `reliefMessageSuffix` are PURE. They are what
 *     MemoryGuard's page carries.
 *   - `handleReliefButton` is the interaction side, structurally typed so it
 *     tests without a discord.js client.
 *
 * The suffix matters as much as the button. `deliverAdminAlert` falls back
 * webhook → bot-direct → pino, and only the webhook leg can carry components
 * — so on a fallback the button silently does not exist. A page whose only
 * remediation is an invisible button would be strictly worse than the plain
 * text it replaced, hence: every page names its CLI equivalent inline,
 * whether or not the button made it.
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} from "discord.js";
import type { Logger } from "pino";
import {
  encodeReliefId,
  executeRelief,
  parseReliefId,
  RELIEF_TTL_MS,
  type ReliefDeps,
} from "../manager/memory-relief.js";
import {
  isValidContainerName,
  restartUnraidContainer,
  type ContainerRestartDeps,
} from "../homelab/unraid-watch-service.js";

export { MEMREL_PREFIX } from "../manager/memory-relief.js";

export interface ReliefOffer {
  readonly pid: number;
  readonly comm: string;
  readonly anonSwapMb: number;
  readonly startTicks: number;
  readonly issuedAtMs: number;
}

/**
 * Label reads as the ACTION plus its subject, never a bare "Fix it": the
 * operator clicking this is authorising a SIGKILL and should see exactly what
 * dies. Discord caps labels at 80 chars; comm is ≤15 (kernel TASK_COMM_LEN).
 */
export function reliefButtonLabel(offer: ReliefOffer): string {
  return `Kill ${offer.comm} (pid ${offer.pid}) · ${offer.anonSwapMb}MB`;
}

/** One danger-styled button. Red because it is destructive and irreversible. */
export function buildReliefRow(offer: ReliefOffer): unknown {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(
          encodeReliefId({
            pid: offer.pid,
            startTicks: offer.startTicks,
            issuedAtMs: offer.issuedAtMs,
          }),
        )
        .setLabel(reliefButtonLabel(offer))
        .setEmoji("🩹")
        .setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

/**
 * The always-present text equivalent. Delivered on EVERY leg, so the operator
 * is never left with a page they cannot act on.
 */
export function reliefMessageSuffix(offer: ReliefOffer): string {
  return `\nTop consumer: \`${offer.comm}\` pid ${offer.pid} (${offer.anonSwapMb}MB). Relieve with the button below, or: \`clawcode mem relieve --pid ${offer.pid}\``;
}

/**
 * True when an offender is worth offering a button for. A 40MB "top consumer"
 * is not the cause of anything, and a button that frees nothing trains the
 * operator to distrust the ones that matter.
 */
export function worthOffering(anonSwapMb: number, floorMb = 512): boolean {
  return anonSwapMb >= floorMb;
}

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

/**
 * Minimal STRUCTURAL shape — same discipline as `ButtonInteractionLike` in
 * cutover/button-handler.ts. Deliberately not `Pick<ButtonInteraction, ...>`:
 * that drags in the full discord.js `User` class (35 members), so a test
 * would have to mock a Discord client to check a refusal string.
 */
export type ReliefInteractionLike = {
  readonly customId: string;
  readonly user?: { readonly id: string };
  reply: (opts: { content: string; flags?: number }) => Promise<unknown>;
};

/**
 * Route one relief click. ALWAYS replies — ephemerally, so a refusal reason
 * does not add noise to the channel the operator is already unhappy about.
 *
 * Never throws: the caller registers this on `interactionCreate`, where an
 * unhandled rejection takes the whole daemon down (the `.catch` on the
 * other interaction arms exists for exactly that reason).
 */
export async function handleReliefButton(
  interaction: ReliefInteractionLike,
  deps: ReliefDeps,
): Promise<void> {
  const target = parseReliefId(interaction.customId);
  if (!target) {
    await safeReply(
      interaction,
      "⚠️ This relief button is malformed and was ignored.",
      deps.log,
    );
    return;
  }
  let message: string;
  try {
    const outcome = await executeRelief(
      target,
      `discord:${interaction.user?.id ?? "unknown"}`,
      deps,
    );
    message = outcome.message;
  } catch (err) {
    // executeRelief is defensive, but a dep injected by the daemon could
    // still throw — and this must not reach the interactionCreate handler.
    deps.log.warn(
      {
        tag: "memory-relief",
        err: err instanceof Error ? err.message : String(err),
      },
      "memory relief handler threw (non-fatal)",
    );
    message = "❌ Relief failed unexpectedly — check the daemon journal.";
  }
  await safeReply(interaction, message, deps.log);
}

async function safeReply(
  interaction: ReliefInteractionLike,
  content: string,
  log: Logger,
): Promise<void> {
  try {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (err) {
    // Interaction tokens expire after 15 minutes; a click on an old page is
    // an expected miss, not an error worth waking anyone for. The action
    // itself has already happened and is in the audit trail either way.
    log.debug(
      {
        tag: "memory-relief",
        err: err instanceof Error ? err.message : String(err),
      },
      "memory relief reply failed (interaction likely expired)",
    );
  }
}

// ---------------------------------------------------------------------------
// Unraid: restart ONE named container
// ---------------------------------------------------------------------------

/**
 * `memrel:d:<container>:<issuedAtSec>` — same prefix as the kill button so a
 * single strict-prefix arm on `interactionCreate` routes both, discriminated
 * by the action letter. Container names cannot contain `:`
 * (`[a-zA-Z0-9][a-zA-Z0-9_.-]*`), so the split is unambiguous.
 */
export function encodeContainerReliefId(
  container: string,
  issuedAtMs: number,
): string {
  return `memrel:d:${container}:${Math.floor(issuedAtMs / 1000)}`;
}

export function parseContainerReliefId(
  customId: string,
): { container: string; issuedAtMs: number } | null {
  if (!customId.startsWith("memrel:d:")) return null;
  const parts = customId.split(":");
  if (parts.length !== 4) return null;
  const container = parts[2];
  const issuedAtSec = Number(parts[3]);
  // Validated HERE as well as at the action, because this string is about to
  // be interpolated into a shell command over SSH.
  if (!isValidContainerName(container) || !Number.isInteger(issuedAtSec)) {
    return null;
  }
  return { container, issuedAtMs: issuedAtSec * 1000 };
}

export function buildContainerReliefRow(
  container: string,
  memMb: number,
  issuedAtMs: number,
): unknown {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId(encodeContainerReliefId(container, issuedAtMs))
        .setLabel(`Restart ${container} · ${memMb}MB`)
        .setEmoji("🔄")
        .setStyle(ButtonStyle.Danger),
    )
    .toJSON();
}

export function containerReliefSuffix(
  container: string,
  memMb: number,
): string {
  return `\nTop container: \`${container}\` (${memMb}MB). Restart it with the button below, or: \`ssh root@unraid docker restart ${container}\``;
}

/**
 * Route one container-restart click. Same never-throws, always-reply-
 * ephemerally contract as the kill handler.
 */
export async function handleContainerReliefButton(
  interaction: ReliefInteractionLike,
  deps: ContainerRestartDeps & { readonly ttlMs?: number },
): Promise<void> {
  const parsed = parseContainerReliefId(interaction.customId);
  if (!parsed) {
    await safeReply(
      interaction,
      "⚠️ This restart button is malformed and was ignored.",
      deps.log,
    );
    return;
  }
  const now = deps.now?.() ?? Date.now();
  if (now - parsed.issuedAtMs > (deps.ttlMs ?? RELIEF_TTL_MS)) {
    await safeReply(
      interaction,
      `⚠️ Not restarted — this button expired. Re-check Unraid before acting.`,
      deps.log,
    );
    return;
  }
  let message: string;
  try {
    const outcome = await restartUnraidContainer(
      parsed.container,
      `discord:${interaction.user?.id ?? "unknown"}`,
      deps,
    );
    message = outcome.message;
  } catch (err) {
    deps.log.warn(
      {
        tag: "unraid-watch",
        err: err instanceof Error ? err.message : String(err),
      },
      "container relief handler threw (non-fatal)",
    );
    message = "❌ Restart failed unexpectedly — check the daemon journal.";
  }
  await safeReply(interaction, message, deps.log);
}
