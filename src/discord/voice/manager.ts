/**
 * Phase 135 Plan 02 — VoiceManager: voice-channel lifecycle owner.
 *
 * Owns the per-guild VoiceSession map for a single DiscordBridge. Plan 02
 * fills in the real runtime that Plan 01 stubbed:
 *
 *   - `join(agentName, channelId)`: calls `joinVoiceChannel(...)`, awaits
 *     `VoiceConnectionStatus.Ready` within 10s, subscribes a fresh
 *     `AudioPlayer`, opens the per-session Deepgram WS, attaches the
 *     `receiver.speaking.on("start")` per-user pipeline.
 *   - `leave(guildId)`: destroys the connection, closes the Deepgram WS,
 *     drops the session from the map.
 *   - `status()`: returns one entry per live session for the `/vc status`
 *     slash command.
 *   - `autoJoin()`: walks `resolvedAgents`, joins each agent with
 *     `voice.channelId` set; remembers fatal-failure outcomes in
 *     `fatalAutoJoinFailures` so retries (e.g., `client.resumed`) don't
 *     storm Discord with a known-broken join.
 *   - `handleUserLeave(guildId, userId)`: closes the per-user receiver
 *     subscription + invalidates the dedup generation. Wired from
 *     DiscordBridge's `voiceStateUpdate` listener (RESEARCH Pitfall 5).
 *
 * Per RESEARCH Pitfall 8: every public entry point catches at its own
 * boundary and never re-throws into the shared discord.js Client.
 */
import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  entersState,
  createAudioPlayer,
  EndBehaviorType,
  type VoiceConnection,
  type AudioPlayer,
} from "@discordjs/voice";
import type { Client, GuildBasedChannel } from "discord.js";
import type { Logger } from "pino";
import type { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import type { AgentWithVoice } from "./config.js";
import {
  createVoiceSession,
  ensureSessionStats,
  summarizeSessionStats,
  type VoiceSession,
  type DeepgramLiveConnection,
} from "./session.js";
import {
  beginVoiceCapture,
  currentGeneration,
  finishVoiceCapture,
} from "./capture-state.js";
import { decodeOpusToLinear16 } from "./audio.js";
import {
  openDeepgramConnection,
  type DeepgramTranscriptCallbacks,
  type VadConfig,
} from "./stt.js";
import { MinutesTracker } from "./minutes-cap.js";
import {
  abortVoiceTurn,
  beginBargeIn,
  evaluateBargeInInterim,
  resolveBargeInConfig,
} from "./turn-state.js";
import { openFluxConnection, downmixStereoToMono } from "./stt-flux.js";
import type { VoiceSttTiming } from "./turn-trace.js";

/**
 * Phase 135.1 — non-logging predicate: may this speaker's voice interrupt the
 * agent? Injected by the daemon from the bridge's channel ACL (setBargeInAcl).
 * Null when unwired (tests / no policies) → barge-in fails open (bot-filtered).
 */
export type BargeInAclPredicate = (
  agentName: string,
  channelId: string,
  voiceUserId: string,
) => boolean;

export type VoiceSessionStatusEntry = {
  readonly id: string;
  readonly agent: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly durationMs: number;
  readonly minutesUsedThisMonth: number;
};

/**
 * Callback shape: a Deepgram final transcript was received for `userId` on
 * `session`. DiscordBridge.handleVoiceTranscript is wired here from
 * `ingress.ts` so the manager itself stays free of bridge imports
 * (avoids a circular dependency between bridge.ts and manager.ts).
 */
export type TranscriptDispatcher = (
  session: VoiceSession,
  transcript: string,
  voiceUserId: string,
  /** 999.116 A3 (G7) — STT decision timing, threaded to the turn trace. */
  sttTiming?: VoiceSttTiming,
) => Promise<void> | void;

/**
 * Phase 135 Plan 03 Task 3 — cap-warning sink.
 *
 * Invoked when the per-session minutes cap is exceeded. Implementations
 * post a warning to the agent's text channel (the bridge has the
 * routing table mapping agent → channels). VoiceManager owns the
 * disconnect (calls `leave(guildId)`); the sink only handles the
 * user-visible notification.
 *
 * Failures in the sink are caught + logged; they do NOT block the
 * disconnect.
 */
export type CapWarningSink = (
  agentName: string,
  capMinutes: number,
) => Promise<void> | void;

/**
 * Predicate: is `err` a fatal join failure that should NOT be retried on
 * the next `autoJoin()` call?
 *
 * Fatal:
 *   - Discord API code 50013 — Missing Permissions (Connect/Speak).
 *   - Discord API code 10003 — Unknown Channel (channel deleted).
 *   - "Cannot join voice channel" / "Invalid channel type" messages.
 *
 * Transient (NOT fatal — will be retried on `ready`/`resumed`):
 *   - Network blips, gateway disconnects, Ready-timeout.
 */
export function isFatalAutoJoinFailure(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown };
  if (typeof e.code === "number") {
    if (e.code === 50013) return true; // Missing Permissions
    if (e.code === 10003) return true; // Unknown Channel
    if (e.code === 50001) return true; // Missing Access
  }
  if (typeof e.message === "string") {
    const m = e.message.toLowerCase();
    if (m.includes("missing permission")) return true;
    if (m.includes("unknown channel")) return true;
    if (m.includes("invalid channel type")) return true;
  }
  return false;
}

/** 999.116 hotfix — spoken on every join unless `voice.joinGreeting` is "". */
export const DEFAULT_JOIN_GREETING = "I'm listening.";

/** 999.116 hotfix — daemon-wired speaker for the join greeting (tts.speakResponse). */
export type JoinGreetingSpeaker = (session: VoiceSession, text: string) => Promise<unknown>;

/**
 * Phase 135.4 — VAD knobs from the per-agent voice block. `undefined` fields
 * fall through to the stt.ts DEFAULT_* so the fleet inherits new defaults
 * without yaml edits. Shared by the initial open and the reconnect path.
 */
function vadOptionsFor(voiceCfg: VoiceSession["voiceCfg"]): VadConfig {
  return {
    utteranceEndMs: voiceCfg.utteranceEndMs,
    endpointingMs: voiceCfg.endpointingMs,
    minConfidence: voiceCfg.minConfidence,
    minWordCount: voiceCfg.minWordCount,
    keyterms: voiceCfg.keyterms,
  };
}

export class VoiceManager {
  private readonly client: Client;
  private readonly log: Logger;
  private readonly resolvedAgents: readonly AgentWithVoice[];
  private readonly sessions: Map<string, VoiceSession>;
  /**
   * `${agentName}:${channelId}` → fatal error message. Set when `autoJoin`
   * encounters a non-retryable failure (permission, channel-deleted, etc.).
   * Cleared only by an explicit `clearFatalFailures()` call (not exposed
   * publicly today — operators must restart the daemon to retry).
   */
  private readonly fatalAutoJoinFailures: Map<string, string>;
  /**
   * Optional dispatcher injected by DiscordBridge during boot wiring.
   * Receives final transcripts from the Deepgram callback. When unset
   * (e.g., unit tests that exercise `join`/`leave` only), transcripts
   * are logged and dropped.
   */
  private transcriptDispatcher: TranscriptDispatcher | null = null;
  /**
   * Phase 135 Plan 03 — sink for cap-hit warnings. Bridge wires this
   * at boot via `setCapWarningSink`. Null when unwired (unit tests
   * exercising join/leave only) — cap-hit then just disconnects
   * without a Discord-side post.
   */
  private capWarningSink: CapWarningSink | null = null;
  /**
   * Phase 135.1 — barge-in ACL gate. Wired by the daemon from the bridge's
   * channel ACL. Null → fail open (bot-filtered). Only gates *interrupting*
   * the agent; the actual turn is still ACL-gated at final-transcript dispatch.
   */
  private bargeInAcl: BargeInAclPredicate | null = null;
  /**
   * Phase 135.1 Phase 5 — Flux connection open in-flight (`${sessionId}:${userId}`),
   * so concurrent speaking-starts / reconnect ticks don't double-open, and
   * per-user backoff timestamps after a failed open (storm guard).
   */
  private readonly fluxPending = new Set<string>();
  private readonly fluxReconnectAfter = new Map<string, number>();
  /**
   * 999.116 hotfix — speaks the join greeting. Wired by the daemon to
   * tts.speakResponse; null in unit tests (no network) and then no greeting.
   */
  private greetingSpeaker: JoinGreetingSpeaker | null = null;
  /** 999.116 hotfix — guilds with an auto-join in flight (dedupe rapid voiceStateUpdates). */
  private readonly joinInFlight = new Set<string>();

  constructor(
    client: Client,
    log: Logger,
    resolvedAgents: readonly AgentWithVoice[],
    sessions: Map<string, VoiceSession> = new Map<string, VoiceSession>(),
  ) {
    this.client = client;
    this.log = log.child({ component: "voice-manager" });
    this.resolvedAgents = resolvedAgents;
    this.sessions = sessions;
    this.fatalAutoJoinFailures = new Map();
  }

  /**
   * Phase 135 Plan 03 — install the cap-warning sink. Idempotent;
   * subsequent calls overwrite.
   */
  setCapWarningSink(sink: CapWarningSink | null): void {
    this.capWarningSink = sink;
  }

  /**
   * Phase 135.1 — install the barge-in ACL gate (from the bridge's channel
   * ACL). Idempotent; subsequent calls overwrite.
   */
  setBargeInAcl(pred: BargeInAclPredicate | null): void {
    this.bargeInAcl = pred;
  }

  /** 999.116 hotfix — install the greeting speaker (daemon wiring). */
  setGreetingSpeaker(speaker: JoinGreetingSpeaker | null): void {
    this.greetingSpeaker = speaker;
  }

  /**
   * Phase 135.1 Phase 3 — barge-in Stage A. On a speaking-start while the
   * agent is speaking, pause playback and open a tentative interrupt (a
   * Deepgram interim then confirms or the rollback timer resumes). Gated on
   * config, a bot filter (cache-only, no fetch), and the channel ACL.
   */
  private maybeBeginBargeIn(session: VoiceSession, userId: string): void {
    try {
      if (session.phase !== "speaking") return;
      const cfg = resolveBargeInConfig(session.voiceCfg);
      if (!cfg.enabled) return;
      // Skip known bots (music bots, other agents) — cache-only, no fetch on
      // the hot speaking-start path.
      if (this.client.users.cache.get(userId)?.bot === true) return;
      if (
        this.bargeInAcl &&
        !this.bargeInAcl(session.agentName, session.channelId, userId)
      ) {
        return;
      }
      if (beginBargeIn(session, cfg)) {
        this.log.debug(
          { sessionId: session.id, userId },
          "barge-in Stage A — playback paused, awaiting confirm",
        );
      }
    } catch (err) {
      this.log.debug(
        { sessionId: session.id, error: (err as Error).message },
        "maybeBeginBargeIn failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 135.1 Phase 3 — barge-in Stage B. Feed a Deepgram interim to the
   * pending-interrupt classifier: a real interrupt aborts the turn; a
   * backchannel resumes playback. No-op unless a barge-in is pending.
   */
  private handleInterimTranscript(
    session: VoiceSession,
    transcript: string,
  ): void {
    try {
      if (session.phase !== "interrupt_pending") return;
      const cfg = resolveBargeInConfig(session.voiceCfg);
      const cls = evaluateBargeInInterim(session, transcript, cfg);
      if (cls === "confirm") {
        this.log.debug(
          { sessionId: session.id },
          "barge-in confirmed — turn aborted",
        );
      } else if (cls === "backchannel") {
        this.log.debug(
          { sessionId: session.id },
          "barge-in rolled back — backchannel",
        );
      }
    } catch (err) {
      this.log.debug(
        { sessionId: session.id, error: (err as Error).message },
        "handleInterimTranscript failed (non-fatal)",
      );
    }
  }

  /**
   * Phase 135 Plan 03 — check the per-session cap after a tracker
   * accumulation. If exceeded: disconnect via leave() + invoke the
   * warning sink. Idempotent — calling after disconnect is a no-op
   * because the session is gone from `this.sessions`.
   */
  async checkCapAndDisconnectIfNeeded(session: VoiceSession): Promise<void> {
    const tracker = session.minutesTracker;
    const cap = session.voiceCfg.monthlyMinutesCap;
    if (!tracker || !cap) return;
    if (!tracker.isCapExceeded(cap)) return;
    this.log.warn(
      {
        agent: session.agentName,
        guildId: session.guildId,
        sessionId: session.id,
        cap,
        secondsUsed: tracker.secondsUsedThisMonth(),
      },
      "voice monthly minutes cap exceeded — disconnecting",
    );
    try {
      await this.leave(session.guildId);
    } catch (err) {
      this.log.error(
        { agent: session.agentName, error: err instanceof Error ? err.message : String(err) },
        "leave() after cap-hit failed (non-fatal)",
      );
    }
    if (this.capWarningSink) {
      try {
        await this.capWarningSink(session.agentName, cap);
      } catch (err) {
        this.log.error(
          {
            agent: session.agentName,
            error: err instanceof Error ? err.message : String(err),
          },
          "capWarningSink threw — disconnect succeeded but user-visible warning failed",
        );
      }
    }
  }

  /**
   * Install the transcript dispatcher. Called once at boot from
   * DiscordBridge wiring; subsequent calls overwrite the prior dispatcher
   * (no enforcement — the bridge owns the lifecycle and there is exactly
   * one bridge per VoiceManager).
   */
  setTranscriptDispatcher(dispatcher: TranscriptDispatcher | null): void {
    this.transcriptDispatcher = dispatcher;
  }

  /**
   * Walk `resolvedAgents` and call `join()` for every agent with a
   * `voice.channelId` set. Skips agents already recorded as fatal failures
   * to prevent retry storms on `client.on("resumed")`.
   *
   * Errors from individual joins are logged and swallowed (Pitfall 8) —
   * one bad agent must not prevent the rest from joining.
   */
  async autoJoin(): Promise<void> {
    try {
      let attempted = 0;
      let fatal = 0;
      let transient = 0;
      let succeeded = 0;
      for (const agent of this.resolvedAgents) {
        if (!agent.voice || !agent.voice.channelId) continue;
        if (agent.voice.autoJoin !== true) {
          this.log.debug(
            { agent: agent.name, channelId: agent.voice.channelId },
            "voice auto-join skipped (autoJoin not enabled)",
          );
          continue;
        }
        const key = `${agent.name}:${agent.voice.channelId}`;
        if (this.fatalAutoJoinFailures.has(key)) {
          this.log.debug(
            { agent: agent.name, channelId: agent.voice.channelId, reason: this.fatalAutoJoinFailures.get(key) },
            "voice auto-join skipped (prior fatal failure)",
          );
          continue;
        }
        attempted++;
        try {
          await this.join(agent.name, agent.voice.channelId);
          succeeded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isFatalAutoJoinFailure(err)) {
            this.fatalAutoJoinFailures.set(key, msg);
            fatal++;
            this.log.error(
              { agent: agent.name, channelId: agent.voice.channelId, error: msg },
              "voice auto-join fatal failure — will NOT retry until daemon restart",
            );
          } else {
            transient++;
            this.log.warn(
              { agent: agent.name, channelId: agent.voice.channelId, error: msg },
              "voice auto-join transient failure — will retry on next ready/resumed",
            );
          }
        }
      }
      this.log.info(
        { attempted, succeeded, fatal, transient },
        "voice auto-join sweep complete",
      );
    } catch (err) {
      // Defense in depth — autoJoin's outer try should never throw, but
      // if it does we MUST NOT let it bubble into the client.on("ready")
      // handler (would crash discord.js's listener pump).
      this.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "voice autoJoin sweep failed (caught at outer boundary)",
      );
    }
  }

  /**
   * Open a voice connection for `agentName` to `channelId`. On success
   * the session is stored in `this.sessions` keyed by guildId.
   *
   * Throws on any failure (permission, channel-deleted, Ready-timeout,
   * Deepgram-open-failure). Callers (autoJoin, /vc join slash handler)
   * are responsible for catching and surfacing a friendly message.
   */
  async join(agentName: string, channelId: string): Promise<VoiceSession> {
    const agent = this.resolvedAgents.find((a) => a.name === agentName);
    if (!agent || !agent.voice) {
      throw new Error(`agent '${agentName}' has no voice config`);
    }
    const voiceCfg = agent.voice;

    // Resolve the target channel + its guild adapter creator.
    const channel = (await this.client.channels.fetch(channelId)) as
      | (GuildBasedChannel & {
          readonly guild: {
            readonly id: string;
            readonly voiceAdapterCreator: unknown;
          };
        })
      | null;
    if (!channel) {
      const err = new Error(`channel ${channelId} not found`);
      (err as { code?: number }).code = 10003;
      throw err;
    }
    const guildId = channel.guild?.id;
    if (!guildId) {
      throw new Error(`channel ${channelId} has no guild (DM channels cannot host voice)`);
    }

    // joinVoiceChannel — the synchronous primitive. discord.js doesn't
    // throw from join itself; failures surface on the `Ready` transition.
    const connection: VoiceConnection = joinVoiceChannel({
      channelId,
      guildId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      adapterCreator: channel.guild.voiceAdapterCreator as any,
      // selfDeaf=false is required so receiver.subscribe gets opus packets.
      selfDeaf: false,
      selfMute: false,
    });

    try {
      // Wait for Ready (10s timeout per RESEARCH § Code Examples).
      await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
    } catch (err) {
      // Clean up the half-open connection before re-throwing.
      try {
        connection.destroy();
      } catch {
        /* non-fatal */
      }
      throw err;
    }

    // 999.116 hotfix — the transport facts a silent call needs: which
    // encryption mode Discord negotiated and whether DAVE (E2EE) is on.
    {
      const net = (connection.state as unknown as { networking?: { state?: { connectionData?: { encryptionMode?: string }; dave?: { protocolVersion?: number } } } }).networking?.state;
      this.log.info(
        {
          agent: agentName,
          guildId,
          channelId,
          encryptionMode: net?.connectionData?.encryptionMode ?? null,
          daveProtocolVersion: net?.dave?.protocolVersion ?? null,
        },
        "voice connection ready",
      );
    }

    // Phase 135.1 Phase 4 — tolerate WS-TTS jitter. The default
    // maxMissedFrames=5 stops playback after ~100ms of buffer underflow, which
    // a sentence-streamed WebSocket can hit between sentences; 250 (~5s) rides
    // out streaming gaps. Harmless for the HTTP/mp3 fallback path.
    const player: AudioPlayer = createAudioPlayer({
      behaviors: { maxMissedFrames: 250 },
    });
    connection.subscribe(player);

    const session: VoiceSession = createVoiceSession({
      id: randomUUID(),
      agentName,
      channelId,
      guildId,
      // VoiceConfigShape is now a re-export of the real VoiceConfig (Plan 02).
      voiceCfg: voiceCfg as unknown as VoiceSession["voiceCfg"],
    });
    session.connection = connection;
    session.player = player;

    // Phase 135 Plan 03 Task 3 — per-session minutes tracker.
    // Persists at <memoryPath>/voice-minutes.json; constructor handles
    // first-run init + UTC monthly rollover lazily. memoryPath is
    // optional in the AgentWithVoice type for fixture compat — fall
    // back to a workspace path or skip if neither is available
    // (skipping = no cap enforcement, logged loudly).
    if (agent.memoryPath) {
      try {
        session.minutesTracker = new MinutesTracker({
          agentName,
          memoryPath: agent.memoryPath,
          log: this.log,
        });
      } catch (err) {
        this.log.error(
          {
            agent: agentName,
            memoryPath: agent.memoryPath,
            error: err instanceof Error ? err.message : String(err),
          },
          "MinutesTracker init failed — voice session continues without cap enforcement",
        );
      }
    } else {
      this.log.warn(
        { agent: agentName },
        "agent has no memoryPath — voice session continues without cap enforcement",
      );
    }

    // Open the Deepgram WS — ONE per session, NOT per utterance
    // (RESEARCH Pitfall 4). The connection is closed in `leave()`. The
    // callback set is built by buildDeepgramCallbacks (shared with the
    // reconnect path) — see its doc for the speaker-attribution contract.
    try {
      const dg: DeepgramLiveConnection = await openDeepgramConnection(
        voiceCfg.deepgramKey,
        this.buildDeepgramCallbacks(session, ""),
        vadOptionsFor(voiceCfg),
      );
      session.deepgramConnection = dg;
    } catch (err) {
      // Failed to open Deepgram — tear down the half-built voice
      // connection so we don't leak resources.
      try {
        connection.destroy();
      } catch {
        /* non-fatal */
      }
      throw err;
    }

    // 999.116 hotfix — surface DAVE / transport events at info (bounded).
    this.attachConnectionObservers(session);

    // Attach the per-user receiver pipeline.
    this.attachSpeakingListeners(session);

    this.sessions.set(guildId, session);
    this.log.info(
      { agent: agentName, guildId, channelId, sessionId: session.id },
      "voice session opened",
    );
    // 999.116 hotfix — say something on join: proves TTS + the encrypted
    // send path on every call and tells the user the agent is really there.
    void this.speakJoinGreeting(session);
    return session;
  }

  /**
   * 999.116 hotfix — ONE builder for the Deepgram callback set, used by the
   * initial open and the reconnect path (they had drifted into two ~100-line
   * copies). `suffix` tags the reconnect path's log lines the way the old
   * copies did. Every callback also feeds the per-session receive stats so a
   * silent call is diagnosable from the journal at info level.
   *
   * Speaker attribution (Plan 02): Deepgram V1 streaming carries no per-user
   * attribution on the shared WS, so a final is attributed to the user whose
   * `receiver.speaking.on("start")` fired most recently.
   */
  private buildDeepgramCallbacks(
    session: VoiceSession,
    suffix: "" | " (after reconnect)",
  ): DeepgramTranscriptCallbacks {
    const { agentName, guildId } = session;
    const stats = ensureSessionStats(session);
    // stt.ts fires onTurnFlush (with the trigger reason) synchronously right
    // before onFinalTranscript; carry it across for the turn trace.
    let lastFlushReason: string | undefined;
    return {
      onFinalTranscript: (transcript, audioDurationSeconds) => {
        stats.sttFinals += 1;
        const userId = session.lastSpeakerUserId;
        const capturedGeneration = session.lastSpeakerGeneration;
        if (!userId) {
          // Phase 135 REVIEW WR-01 — length only, never the text. Promoted to
          // info (999.116): a final with no speaker is a real loss, not noise.
          this.log.info(
            { sessionId: session.id, transcriptLength: transcript.length },
            "final transcript arrived with no recorded speaker — dropping",
          );
          return;
        }
        // Phase 135 Plan 03 — accumulate utterance seconds against the
        // monthly cap; wall-clock since speaker-start when Deepgram reports 0.
        if (session.minutesTracker) {
          let seconds = audioDurationSeconds;
          if (seconds <= 0) {
            const startedAt = session.utteranceStartedAt.get(userId);
            if (startedAt) seconds = (Date.now() - startedAt) / 1000;
          }
          if (seconds > 0) {
            session.minutesTracker.addUtteranceSeconds(seconds);
            void this.checkCapAndDisconnectIfNeeded(session).catch((err) => {
              this.log.error(
                { agent: agentName, error: err instanceof Error ? err.message : String(err) },
                "checkCapAndDisconnectIfNeeded after utterance failed",
              );
            });
          }
        }
        this.handleFinalTranscript(
          session,
          userId,
          transcript,
          capturedGeneration,
          this.buildSttTiming(session, userId, lastFlushReason),
        );
      },
      onInterimTranscript: (transcript: string) => {
        stats.sttInterims += 1;
        if (stats.sttInterims === 1) {
          // The second of the two lines that make a silent call diagnosable:
          // Deepgram produced words, so audio decode + upload work.
          this.log.info(
            { agent: agentName, guildId, sessionId: session.id, transcriptLength: transcript.length },
            "voice stt hearing speech — first interim transcript",
          );
        }
        // Phase 135.1 Phase 3 — interims feed barge-in Stage B.
        this.handleInterimTranscript(session, transcript);
      },
      onError: (err) => {
        this.log.error(
          { agent: agentName, guildId, error: err.message },
          `deepgram WS error${suffix}`,
        );
      },
      // Phase 135.4 VAD rejects — promoted debug→info (999.116): rare, and
      // exactly what explains "I spoke and nothing happened".
      onLowConfidenceReject: (transcript, confidence) => {
        stats.sttDropsLowConfidence += 1;
        this.log.info(
          {
            agent: agentName,
            guildId,
            sessionId: session.id,
            transcriptLength: transcript.length,
            confidence,
            reason: "below_min_confidence",
          },
          `voice final transcript dropped — low confidence${suffix}`,
        );
      },
      onShortUtteranceReject: (transcript, wordCount) => {
        stats.sttDropsShortUtterance += 1;
        this.log.info(
          {
            agent: agentName,
            guildId,
            sessionId: session.id,
            transcriptLength: transcript.length,
            wordCount,
            reason: "below_min_word_count",
          },
          `voice final transcript dropped — short utterance${suffix}`,
        );
      },
      // Phase 135 REBUILD — one "voice turn dispatched" per spoken turn.
      onTurnFlush: (reason, segments, chars) => {
        lastFlushReason = reason;
        stats.turnsDispatched += 1;
        this.log.info(
          { agent: agentName, guildId, sessionId: session.id, reason, segments, chars },
          `voice turn dispatched${suffix}`,
        );
      },
      onDeadAirFinalize: () => {
        this.log.info(
          { agent: agentName, guildId, sessionId: session.id },
          `voice dead-air rescue — sent Finalize to flush Deepgram${suffix}`,
        );
      },
      onClose: () => {
        this.log.info({ agent: agentName, guildId }, `deepgram WS closed${suffix}`);
        session.deepgramConnection = null;
        // 135.0.6 — auto-reconnect while the session is live. leave() removes
        // the session from the map BEFORE closing the WS (999.116 hotfix), so
        // a teardown close never spawns a reconnect for a dead session.
        if (this.sessions.get(guildId) !== session) return;
        this.log.info(
          { agent: agentName, guildId, sessionId: session.id },
          suffix ? "attempting deepgram WS reconnect (chained)" : "attempting deepgram WS reconnect",
        );
        void this.reopenDeepgramForSession(session).catch((err) => {
          this.log.error(
            { agent: agentName, guildId, error: err instanceof Error ? err.message : String(err) },
            suffix
              ? "deepgram WS reconnect failed (chained)"
              : "deepgram WS reconnect failed — voice STT is dead until /vc leave + /vc join",
          );
        });
      },
    };
  }

  /**
   * 135.0.6 — re-establish the Deepgram WS for an active session after the
   * previous WS closed. Same callback shape as the initial open (shared
   * builder); the reopened connection reconnects again if it closes.
   */
  private async reopenDeepgramForSession(session: VoiceSession): Promise<void> {
    if (this.sessions.get(session.guildId) !== session) {
      this.log.debug({ sessionId: session.id }, "deepgram reconnect skipped — session closed");
      return;
    }
    const { agentName, guildId, voiceCfg } = session;
    const dg = await openDeepgramConnection(
      voiceCfg.deepgramKey,
      this.buildDeepgramCallbacks(session, " (after reconnect)"),
      vadOptionsFor(voiceCfg),
    );
    if (this.sessions.get(guildId) !== session) {
      // Torn down while we were connecting — don't leak the new socket.
      try {
        dg.close();
      } catch {
        /* non-fatal */
      }
      return;
    }
    session.deepgramConnection = dg;
    this.log.info(
      { agent: agentName, guildId, sessionId: session.id },
      "deepgram WS reconnect successful",
    );
  }

  /**
   * 999.116 hotfix — forward the voice connection's transport events. DAVE
   * (E2EE) negotiation, decrypt failures, transitions and state changes were
   * only visible via `connection.on("debug")`, which nothing hooked — the
   * exact blind spot behind "the bot joined, I spoke, nothing happened".
   * Important lines go to info (bounded per session); the rest stay debug.
   */
  private attachConnectionObservers(session: VoiceSession): void {
    const conn = session.connection as unknown as
      | { on?: (event: string, cb: (...args: unknown[]) => void) => unknown }
      | null;
    if (!conn || typeof conn.on !== "function") return;
    const stats = ensureSessionStats(session);
    const base = { agent: session.agentName, sessionId: session.id, guildId: session.guildId };
    conn.on("debug", (...args: unknown[]) => {
      const message = String(args[0] ?? "");
      if (/failed to decrypt/i.test(message)) stats.daveFailures += 1;
      const important = /\[DAVE\]|decrypt|transition|downgrad|upgrad|epoch|welcome|commit/i.test(message);
      if (important && stats.connectionDebugLines < 80) {
        stats.connectionDebugLines += 1;
        this.log.info({ ...base, message }, "voice connection event");
      } else {
        this.log.debug({ ...base, message }, "voice connection debug");
      }
    });
    conn.on("error", (...args: unknown[]) => {
      const err = args[0];
      this.log.warn(
        { ...base, error: err instanceof Error ? err.message : String(err) },
        "voice connection error",
      );
    });
    conn.on("stateChange", (...args: unknown[]) => {
      const oldState = args[0] as { status?: string } | undefined;
      const newState = args[1] as { status?: string; reason?: unknown; closeCode?: unknown } | undefined;
      if (oldState?.status === newState?.status) return;
      this.log.info(
        { ...base, from: oldState?.status, to: newState?.status, reason: newState?.reason, closeCode: newState?.closeCode },
        "voice connection state",
      );
    });
  }

  /**
   * 999.116 hotfix — speak the join greeting (fire-and-forget). Its success
   * or failure is logged at info/warn: a failed greeting means the TTS or
   * the encrypted send path is broken, independent of anything the user
   * says. Disabled by `voice.joinGreeting: ""` or when no speaker is wired.
   */
  private async speakJoinGreeting(session: VoiceSession): Promise<void> {
    const text = (session.voiceCfg.joinGreeting ?? DEFAULT_JOIN_GREETING).trim();
    if (text.length === 0 || !this.greetingSpeaker) return;
    const base = { agent: session.agentName, sessionId: session.id, guildId: session.guildId };
    const startedAt = Date.now();
    try {
      await this.greetingSpeaker(session, text);
      this.log.info({ ...base, elapsedMs: Date.now() - startedAt }, "voice join greeting spoken");
    } catch (err) {
      this.log.warn(
        { ...base, error: err instanceof Error ? err.message : String(err) },
        "voice join greeting FAILED — TTS or the send path is broken",
      );
    }
  }

  /**
   * 999.116 hotfix — a human joined a voice channel. If it is an agent's
   * configured voice channel (`autoJoinOnUser` not false) and we are not in
   * it yet, join. Bots never trigger this; fatal prior failures are honored.
   */
  async handleUserJoin(
    guildId: string,
    channelId: string,
    userId: string,
    isBot: boolean,
  ): Promise<void> {
    try {
      if (isBot) return;
      const agent = this.resolvedAgents.find(
        (a) => a.voice?.channelId === channelId && a.voice.autoJoinOnUser !== false,
      );
      if (!agent || !agent.voice) return;
      if (this.sessions.has(guildId) || this.joinInFlight.has(guildId)) return;
      const key = `${agent.name}:${channelId}`;
      if (this.fatalAutoJoinFailures.has(key)) return;
      this.joinInFlight.add(guildId);
      this.log.info(
        { agent: agent.name, guildId, channelId, userId },
        "voice auto-join — a user joined the agent's voice channel",
      );
      try {
        await this.join(agent.name, channelId);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isFatalAutoJoinFailure(err)) this.fatalAutoJoinFailures.set(key, msg);
        this.log.error(
          { agent: agent.name, guildId, channelId, error: msg },
          "voice auto-join on user join FAILED",
        );
      } finally {
        this.joinInFlight.delete(guildId);
      }
    } catch (err) {
      this.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "handleUserJoin failed (caught at boundary)",
      );
    }
  }

  /**
   * 999.116 hotfix — the last human left the channel we are in: leave too
   * (no point transcribing an empty room; the next human join re-joins us).
   */
  async handleChannelEmpty(guildId: string, channelId: string): Promise<void> {
    try {
      const session = this.sessions.get(guildId);
      if (!session || session.channelId !== channelId) return;
      this.log.info(
        { agent: session.agentName, guildId, channelId, sessionId: session.id },
        "voice auto-leave — no humans left in the channel",
      );
      await this.leave(guildId);
    } catch (err) {
      this.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "handleChannelEmpty failed (caught at boundary)",
      );
    }
  }

  /**
   * Tear down the voice session for `guildId`. No-op if no session exists.
   */
  async leave(guildId: string): Promise<void> {
    const session = this.sessions.get(guildId);
    if (!session) {
      this.log.debug({ guildId }, "voice leave: no active session for guild");
      return;
    }
    // 999.116 hotfix — unregister FIRST so the Deepgram onClose fired by the
    // teardown below sees the session gone and does not reconnect a dead
    // session (that leaked a live Deepgram socket per /vc leave).
    this.sessions.delete(guildId);
    try {
      // Phase 135.1 — cancel any in-flight assistant turn first: aborts the
      // LLM/SDK turn via its AbortController and hard-stops TTS + the player,
      // so leave() tears down generation too, not just the audio transport.
      abortVoiceTurn(session, "session-leave");

      // Phase 135.1 Phase 4 — close the streaming-TTS WebSocket if one was opened.
      if (session.ttsSocket) {
        try {
          session.ttsSocket.close();
        } catch (err) {
          this.log.debug(
            { error: (err as Error).message },
            "tts ws close failed (non-fatal)",
          );
        }
        session.ttsSocket = null;
      }

      // Phase 135.1 Phase 5 — close all per-user Flux STT connections.
      if (session.fluxConnections) {
        for (const conn of session.fluxConnections.values()) {
          try {
            conn.close();
          } catch {
            /* non-fatal */
          }
        }
        session.fluxConnections.clear();
      }

      // Close per-user opus receivers first to stop sending audio.
      for (const [userId, opusStream] of session.activeReceivers) {
        try {
          opusStream.destroy();
        } catch (err) {
          this.log.debug(
            { userId, error: (err as Error).message },
            "opus receiver destroy failed",
          );
        }
        finishVoiceCapture(session.captureState, userId);
      }
      session.activeReceivers.clear();

      // Close the Deepgram WS.
      if (session.deepgramConnection) {
        try {
          session.deepgramConnection.close();
        } catch (err) {
          this.log.warn(
            { error: (err as Error).message },
            "deepgram WS close failed (non-fatal)",
          );
        }
      }

      // Stop the audio player.
      try {
        session.player?.stop(true);
      } catch {
        /* non-fatal */
      }

      // Destroy the voice connection.
      try {
        session.connection?.destroy();
      } catch (err) {
        this.log.warn(
          { error: (err as Error).message },
          "voice connection destroy failed (non-fatal)",
        );
      }
    } finally {
      this.sessions.delete(guildId);
      this.log.info(
        {
          agent: session.agentName,
          guildId,
          sessionId: session.id,
          durationMs: Date.now() - session.createdAt,
          ...summarizeSessionStats(session),
        },
        "voice session closed",
      );
    }
  }

  /**
   * Snapshot of every live session. One entry per `(guild)` map slot.
   */
  status(): readonly VoiceSessionStatusEntry[] {
    const now = Date.now();
    const out: VoiceSessionStatusEntry[] = [];
    for (const [guildId, session] of this.sessions) {
      // Phase 135 Plan 03 — the source of truth for the monthly
      // minutes counter is `session.minutesTracker` (filesystem-backed
      // at <memoryPath>/voice-minutes.json). The Plan 02
      // `session.minutesUsedThisMonth` field is now a fallback for
      // sessions that started before MinutesTracker init or where
      // memoryPath was missing.
      const minutesUsedThisMonth = session.minutesTracker
        ? session.minutesTracker.secondsUsedThisMonth() / 60
        : session.minutesUsedThisMonth;
      out.push({
        id: session.id,
        agent: session.agentName,
        guildId,
        channelId: session.channelId,
        durationMs: now - session.createdAt,
        minutesUsedThisMonth,
      });
    }
    return out;
  }

  /**
   * Plan 02 Pitfall 5 — close a per-user receiver subscription when the
   * user leaves voice. Called by DiscordBridge's `voiceStateUpdate`
   * listener. No-op if the user is not currently in a session we own.
   */
  handleUserLeave(guildId: string, userId: string): void {
    try {
      const session = this.sessions.get(guildId);
      if (!session) return;
      const opusStream = session.activeReceivers.get(userId);
      if (!opusStream) return;
      try {
        opusStream.destroy();
      } catch (err) {
        this.log.debug(
          { userId, error: (err as Error).message },
          "opus receiver destroy on user-leave failed",
        );
      }
      session.activeReceivers.delete(userId);
      finishVoiceCapture(session.captureState, userId);
      // Phase 135.1 Phase 5 — close this user's Flux connection on leave.
      const flux = session.fluxConnections?.get(userId);
      if (flux) {
        try {
          flux.close();
        } catch {
          /* non-fatal */
        }
        session.fluxConnections?.delete(userId);
      }
      this.log.debug(
        { guildId, userId, sessionId: session.id },
        "voice user-leave handled — receiver cleanup complete",
      );
    } catch (err) {
      // Pitfall 8 — never let voice-state handling leak into the shared
      // discord.js Client.
      this.log.error(
        { error: err instanceof Error ? err.message : String(err) },
        "handleUserLeave failed (caught at boundary)",
      );
    }
  }

  /**
   * Phase 135.1 Phase 5 — lazily open a per-user Flux STT connection. Called
   * once per user (behind the speaking-start singleton guard). Capped at
   * voice.stt.maxConcurrentConnections. EndOfTurn dispatches; StartOfTurn/Update
   * feed barge-in Stage B. Attribution is exact (one connection per user).
   */
  private async ensureFluxConnection(
    session: VoiceSession,
    userId: string,
  ): Promise<void> {
    if (!session.fluxConnections) session.fluxConnections = new Map();
    if (session.fluxConnections.has(userId)) return;
    const key = `${session.id}:${userId}`;
    // Guard against a double-open race (two speaking-starts / reconnect ticks
    // for the same user before the first WS resolves).
    if (this.fluxPending.has(key)) return;
    // Backoff after a failed open so a persistent failure doesn't storm-reconnect.
    if (Date.now() < (this.fluxReconnectAfter.get(key) ?? 0)) return;
    const cfg = session.voiceCfg.stt;
    const max = cfg?.maxConcurrentConnections ?? 5;
    // Count in-flight opens against the cap so N concurrent first-speaks don't
    // all blow past it before any resolves.
    let pending = 0;
    for (const k of this.fluxPending) {
      if (k.startsWith(`${session.id}:`)) pending++;
    }
    if (session.fluxConnections.size + pending >= max) {
      this.log.debug(
        { sessionId: session.id, userId, max },
        "flux connection cap reached — user not transcribed",
      );
      return;
    }
    this.fluxPending.add(key);
    // Per-connection captured generation: stamped when Flux reports the user
    // started a turn, so a barge-in that finished the capture between
    // StartOfTurn and EndOfTurn doesn't misattribute (per-user Flux is already
    // authoritative, but this keeps handleFinalTranscript's dedup meaningful).
    let capturedGen = currentGeneration(session.captureState, userId);
    try {
      const conn = await openFluxConnection(
        session.voiceCfg.deepgramKey,
        {
          onStartOfTurn: (t) => {
            capturedGen = currentGeneration(session.captureState, userId);
            this.handleInterimTranscript(session, t);
          },
          onUpdate: (t) => this.handleInterimTranscript(session, t),
          onEndOfTurn: (t) => this.handleFluxEndOfTurn(session, userId, t, capturedGen),
          onError: (err) =>
            this.log.error(
              { sessionId: session.id, userId, error: err.message },
              "flux ws error",
            ),
          onClose: () => {
            session.fluxConnections?.delete(userId);
          },
        },
        {
          eotThreshold: cfg?.eotThreshold,
          eagerEotThreshold: cfg?.eagerEotThreshold,
        },
        this.log,
      );
      // If the session was torn down (or another open raced) while connecting,
      // close this one now.
      if (this.sessions.get(session.guildId) !== session || session.fluxConnections.has(userId)) {
        conn.close();
        return;
      }
      session.fluxConnections.set(userId, conn);
      this.fluxReconnectAfter.delete(key);
      this.log.debug({ sessionId: session.id, userId }, "flux connection opened");
    } catch (err) {
      this.fluxReconnectAfter.set(key, Date.now() + 3000);
      this.log.error(
        {
          sessionId: session.id,
          userId,
          error: err instanceof Error ? err.message : String(err),
        },
        "flux connection open failed",
      );
    } finally {
      this.fluxPending.delete(key);
    }
  }

  /**
   * Phase 135.1 Phase 5 — a Flux EndOfTurn: account minutes and dispatch the
   * transcript with exact per-user attribution (no shared-WS last-speaker hack).
   */
  private handleFluxEndOfTurn(
    session: VoiceSession,
    userId: string,
    transcript: string,
    capturedGeneration: number,
  ): void {
    if (transcript.trim().length === 0) return;
    if (session.minutesTracker) {
      const startedAt = session.utteranceStartedAt.get(userId);
      const seconds = startedAt ? (Date.now() - startedAt) / 1000 : 0;
      if (seconds > 0) {
        session.minutesTracker.addUtteranceSeconds(seconds);
        void this.checkCapAndDisconnectIfNeeded(session).catch(() => undefined);
      }
    }
    session.lastSpeakerUserId = userId;
    // Same "voice turn dispatched" record as the nova-3 flush so a verify can
    // count STT decisions against turn traces on either engine.
    this.log.info(
      {
        agent: session.agentName,
        guildId: session.guildId,
        sessionId: session.id,
        reason: "flux_end_of_turn",
        segments: 1,
        chars: transcript.length,
      },
      "voice turn dispatched",
    );
    this.handleFinalTranscript(
      session,
      userId,
      transcript,
      capturedGeneration,
      this.buildSttTiming(session, userId, "flux_end_of_turn"),
    );
  }

  /**
   * 999.116 A3 (G7) — what STT knew at the decision: when it decided, why,
   * and the last audio frame seen from the speaker (= when they stopped
   * talking; absent before their first decoded frame).
   */
  private buildSttTiming(
    session: VoiceSession,
    userId: string,
    reason: string | undefined,
  ): VoiceSttTiming {
    const speechEndAt = session.lastAudioAt?.get(userId);
    return {
      decisionAt: Date.now(),
      ...(reason !== undefined ? { reason } : {}),
      ...(typeof speechEndAt === "number" ? { speechEndAt } : {}),
    };
  }

  /**
   * Wire the speaking-start listener on the session's voice receiver. On
   * each `start(userId)`:
   *
   *   1. Mint a new generation token (`beginVoiceCapture`) + refresh the
   *      single-speaker attribution (see buildDeepgramCallbacks).
   *   2. Barge-in Stage A (Phase 135.1).
   *   3. Open the per-user receive pipeline ONCE per user (decoder-stacking
   *      landmine) — unless the previous one died, in which case rebuild it.
   *
   * 999.116 hotfix: @discordjs/voice destroys a user's receive stream on ANY
   * packet parse/decrypt failure (`stream.destroy(error)` in onUdpMessage).
   * The old singleton guard then kept the dead stream in `activeReceivers`,
   * so one bad packet muted the user for the rest of the session, and the
   * error was a debug line nobody saw. Now: a dead/errored stream is dropped
   * and the next speaking-start re-subscribes; the first packets per user are
   * logged at info; errors are warnings.
   */
  private attachSpeakingListeners(session: VoiceSession): void {
    const conn = session.connection;
    if (!conn) {
      this.log.warn(
        { sessionId: session.id },
        "attachSpeakingListeners called with null connection — skipping",
      );
      return;
    }
    const receiver = conn.receiver;
    const stats = ensureSessionStats(session);
    receiver.speaking.on("start", (userId: string) => {
      try {
        const capturedGeneration = beginVoiceCapture(session.captureState, userId);
        session.lastSpeakerUserId = userId;
        session.lastSpeakerGeneration = capturedGeneration;
        session.utteranceStartedAt.set(userId, Date.now());
        stats.speakingStarts += 1;
        if (!stats.usersHeard.has(userId)) {
          stats.usersHeard.add(userId);
          // The first of the two lines that make a silent call diagnosable:
          // Discord is delivering this user's packets to us.
          this.log.info(
            {
              agent: session.agentName,
              sessionId: session.id,
              guildId: session.guildId,
              userId,
              engine: session.voiceCfg.stt?.engine ?? "nova3",
            },
            "voice hearing user — first packets received",
          );
        }

        // Phase 135.1 Phase 3 — barge-in Stage A on EVERY speaking-start.
        this.maybeBeginBargeIn(session, userId);

        const existing = session.activeReceivers.get(userId);
        if (existing && !existing.destroyed) {
          this.log.debug(
            { sessionId: session.id, userId, generation: capturedGeneration },
            "speaking start — receiver already open, refreshed attribution only",
          );
          return;
        }
        if (existing) {
          // A destroyed stream was left behind — rebuild the pipeline.
          session.activeReceivers.delete(userId);
        }
        this.openReceiverPipeline(session, userId, capturedGeneration);
      } catch (err) {
        this.log.error(
          { sessionId: session.id, userId, error: err instanceof Error ? err.message : String(err) },
          "speaking-start handler failed (caught at boundary)",
        );
      }
    });
  }

  /**
   * 999.116 hotfix — subscribe to one user's Opus stream and wire decode →
   * STT, with every failure observable and self-healing (drop + re-subscribe
   * on the next speech).
   */
  private openReceiverPipeline(
    session: VoiceSession,
    userId: string,
    capturedGeneration: number,
  ): void {
    const conn = session.connection;
    if (!conn) return;
    const stats = ensureSessionStats(session);
    const opusStream: Readable = conn.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    }) as unknown as Readable;
    const pcmStream = decodeOpusToLinear16(opusStream);
    // Phase 135.1 Phase 5 — route audio by STT engine. Flux uses one MONO
    // connection per user; nova-3 forwards stereo to the shared session WS.
    const sttEngine = session.voiceCfg.stt?.engine ?? "nova3";
    if (sttEngine === "flux") {
      void this.ensureFluxConnection(session, userId);
    }
    pcmStream.on("data", (pcm: Buffer) => {
      session.lastAudioAt?.set(userId, Date.now());
      stats.pcmFrames += 1;
      stats.pcmBytes += pcm.length;
      if (sttEngine === "flux") {
        const flux = session.fluxConnections?.get(userId);
        if (!flux) {
          // Dropped / still opening — reconnect (guarded by fluxPending + backoff).
          void this.ensureFluxConnection(session, userId);
          return;
        }
        try {
          flux.sendMedia(downmixStereoToMono(pcm));
        } catch (err) {
          this.log.debug({ userId, error: (err as Error).message }, "flux sendMedia failed (non-fatal)");
        }
        return;
      }
      try {
        session.deepgramConnection?.sendMedia(pcm);
      } catch (err) {
        this.log.debug({ userId, error: (err as Error).message }, "deepgram sendMedia failed (non-fatal)");
      }
    });

    const drop = (what: string, err?: Error) => {
      if (session.activeReceivers.get(userId) !== opusStream) return;
      session.activeReceivers.delete(userId);
      try {
        opusStream.destroy();
      } catch {
        /* non-fatal */
      }
      if (err) {
        stats.receiverErrors += 1;
        this.log.warn(
          { agent: session.agentName, sessionId: session.id, userId, what, error: err.message },
          "voice receiver stream error — subscription dropped; next speech re-subscribes",
        );
      } else {
        this.log.debug({ sessionId: session.id, userId, what }, "voice receiver stream ended — subscription dropped");
      }
    };
    pcmStream.on("error", (err: Error) => drop("opus decoder", err));
    opusStream.on("error", (err: Error) => drop("receiver", err));
    opusStream.on("close", () => drop("close"));

    session.activeReceivers.set(userId, opusStream);
    this.log.debug(
      { sessionId: session.id, userId, generation: capturedGeneration },
      "speaking start — receiver subscription opened",
    );
  }

  /**
   * Plan 02 — final-transcript dispatch with dedup check.
   *
   * The Deepgram callback delivers the transcript along with the
   * generation token captured at speech-start. If the generation has been
   * superseded (another speaking-start fired or finishVoiceCapture ran),
   * the transcript is stale and we drop it silently.
   */
  private handleFinalTranscript(
    session: VoiceSession,
    userId: string,
    transcript: string,
    capturedGeneration: number,
    sttTiming?: VoiceSttTiming,
  ): void {
    try {
      const live = currentGeneration(session.captureState, userId);
      if (live !== capturedGeneration) {
        this.log.debug(
          { sessionId: session.id, userId, capturedGeneration, live },
          "dropping stale final transcript (superseded generation)",
        );
        return;
      }
      // Invalidate the capture before dispatch so any late-arriving
      // interim transcripts for the same utterance are dropped.
      finishVoiceCapture(session.captureState, userId);

      if (!this.transcriptDispatcher) {
        // Phase 135 REVIEW WR-01 — warn-level log fires in production;
        // emit transcript length only, never the raw user-spoken text
        // (security.md "Error messages don't leak sensitive data" +
        // pino-redaction invariant from Phase 999.10).
        this.log.warn(
          { sessionId: session.id, userId, transcriptLength: transcript.length },
          "final transcript received but no dispatcher wired — dropping",
        );
        return;
      }
      // Fire-and-forget — bridge.handleVoiceTranscript runs the agent
      // turn asynchronously. Errors are caught inside ingress.ts.
      void Promise.resolve(
        this.transcriptDispatcher(session, transcript, userId, sttTiming),
      ).catch((err) => {
        this.log.error(
          { sessionId: session.id, userId, error: err instanceof Error ? err.message : String(err) },
          "transcript dispatcher rejected",
        );
      });
    } catch (err) {
      this.log.error(
        { sessionId: session.id, userId, error: err instanceof Error ? err.message : String(err) },
        "handleFinalTranscript failed (caught at boundary)",
      );
    }
  }
}
