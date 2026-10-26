/**
 * Phase 999.43 Plan 02 T03 — `auto-ingest-attachment` IPC handler body,
 * extracted from the daemon's switch for direct testability.
 *
 * Single source of truth for the auto-ingest dispatcher; the daemon
 * switch case delegates here via injected dependencies. Tests in
 * `src/discord/__tests__/auto-ingest-dispatcher.test.ts` exercise this
 * handler with a `:memory:` DocumentStore (Plan 01 T02) + stub engine +
 * stub embedder to assert the four behaviors locked in Plan 02:
 *
 *   1. Agent flag OFF → returns { skipped: true }, no documents row.
 *   2. Classifier reject (video/audio/archive per D-06) → { skipped: true },
 *      no documents row.
 *   3. Happy path (HIGH content + HIGH agent) → engine + docStore.ingest +
 *      upsertDocumentRow with full D-04 provenance + D-01 axis weights
 *      (1.5 × 1.5).
 *   4. Telemetry — phase999.43-autoingest log shape matches the
 *      Phase 101 / Phase 127 / Phase 136 JSON-tag pattern.
 *
 * The daemon case becomes a thin DI wrapper (see
 * src/manager/daemon.ts `case "auto-ingest-attachment"`); this lets the
 * test mock all I/O surfaces without spinning a real daemon.
 *
 * Hot-reload semantics (Plan 01 SUMMARY): `getAgentConfig` MUST be a
 * live read at receive time, not a session-boot snapshot. The daemon
 * passes the live `configs` array reference via `getAgentConfig`.
 */

import { readFile } from "node:fs/promises";
import type { Logger } from "pino";
import {
  classifyAttachment,
  type ContentClass,
} from "../documents/auto-ingest-classifier.js";
import {
  MAX_INGEST_ATTEMPTS,
  type DocumentStore,
  type DocumentRow,
  type DocumentRowInput,
  type IngestStatus,
} from "../documents/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { ChunkInput } from "../documents/chunker.js";
import {
  buildEmptyDocumentStub,
  chunkForMirror,
  chunkWithContext,
  type DocumentChunkContext,
} from "../documents/chunk-context.js";
import {
  type ingest as IngestEngineFn,
  computeDocSlug,
} from "../document-ingest/index.js";
import {
  crossIngestToMemory,
  MigrationPhaseStore,
} from "../document-ingest/cross-ingest.js";
import { displayFilenameFor } from "../document-ingest/remirror.js";
import type { ResolvedAgentConfig } from "../shared/types.js";
import { ManagerError } from "../shared/errors.js";
import { renderAnalysisText, type ImageAnalysis } from "../vision/types.js";
import { isVisionRefusal } from "../vision/refusal-sentinel.js";
import { dHashHex, hammingHex, sha256Hex } from "../vision/image-hash.js";
import { archiveImage, attachmentArchiveDir } from "../vision/image-archive.js";
import {
  IMAGE_INGEST_DEFAULTS,
  type ResolvedImageIngestConfig,
} from "../vision/config.js";

/** Phase 999.154 — near-duplicate lookback window for reusing a prior analysis. */
const NEAR_DUP_LOOKBACK_MS = 7 * 86_400_000;
const NEAR_DUP_SCAN_LIMIT = 500;

/**
 * D-01 Axis 1 multipliers — per-agent base priority (LOCKED VERBATIM).
 * Snapshotted into `agent_priority_weight_at_ingest`; live weight at
 * query time is read fresh per RELOADABLE semantics (Plan 03).
 */
export const AGENT_PRIORITY_WEIGHTS: Readonly<
  Record<"high" | "medium" | "low", number>
> = Object.freeze({ high: 1.5, medium: 1.0, low: 0.7 });

/**
 * D-01 Axis 2 multipliers — per-document content priority (LOCKED VERBATIM).
 * Same numbers as `CONTENT_PRIORITY_WEIGHTS` in `src/documents/store.ts`;
 * duplicated here so the daemon case body has the literal in source for
 * operator grep + acceptance-gate assertions.
 */
export const CONTENT_PRIORITY_WEIGHTS: Readonly<
  Record<"high" | "medium" | "low", number>
> = Object.freeze({ high: 1.5, medium: 1.0, low: 0.5 });

/** IPC request payload (matches `auto-ingest-attachment` in protocol.ts). */
export type AutoIngestAttachmentParams = {
  readonly agent: string;
  readonly file_path: string;
  readonly filename: string;
  readonly mime_type: string | null;
  readonly size: number;
  readonly vision_analysis: string | null;
  readonly channel_id: string;
  readonly message_id: string;
  readonly user_id: string;
  readonly user_name: string;
  /**
   * WP3 (2026-10-25): Discord channel name for the contextual chunk header
   * ("from <user> in #<channel>"). Optional; omitted from the header when
   * absent (the bridge does not send it yet).
   */
  readonly channel_name?: string;
  /**
   * 999.156 — "transcript": a finished transcription the operator asked to be
   * retrievable. Ingested even when the agent's `autoIngestAttachments` flag
   * is off, classified HIGH, recorded as source_kind "transcript".
   */
  readonly origin?: "transcript";
};

/** DI deps — the daemon wires concrete impls; tests pass stubs. */
export type AutoIngestHandlerDeps = {
  readonly getDocumentStore: (agent: string) => DocumentStore | undefined;
  readonly getMemoryStore: (agent: string) => MemoryStore | undefined;
  /**
   * P1-EMBED-WORKER — compute embeddings in the dedicated worker (off the main
   * event loop). v2 (bge int8) is always returned (serves docStore.ingest AND
   * crossIngest); v1 (MiniLM float32) only when `includeV1` (cross-ingest will
   * run). Results are index-aligned with `texts`. Replaces the old per-chunk
   * `getEmbedder().embedV2()` loop that blocked the event loop during bursts.
   */
  readonly embedBoth: (
    texts: readonly string[],
    includeV1: boolean,
  ) => Promise<{
    readonly v1: Float32Array[] | null;
    readonly v2: Int8Array[];
  }>;
  readonly getAgentConfig: (agent: string) => ResolvedAgentConfig | undefined;
  readonly logger: Logger;
  /**
   * Phase 101 engine. Daemon passes the real `ingestDocumentEngine`;
   * tests pass a stub that returns canned text + telemetry.
   */
  readonly engine: typeof IngestEngineFn;
  /** Optional: override readFile for tests. Defaults to node:fs/promises.readFile. */
  readonly readFileFn?: (path: string) => Promise<Buffer>;
  /** Optional: override clock for deterministic ingestedAt in tests. */
  readonly nowIso?: () => string;
  /**
   * Phase 999.154 WS-3 — batched structured vision for this image (the daemon
   * wires IngestVisionBatcher: one labeled call per upload burst). Returns
   * null when no provider produced a truthful analysis. Absent ⇒ no vision.
   */
  readonly analyzeImage?: (params: AutoIngestAttachmentParams) => Promise<ImageAnalysis | null>;
  /** Phase 999.154 — dedupe + archive knobs; defaults IMAGE_INGEST_DEFAULTS. */
  readonly imageIngest?: Pick<ResolvedImageIngestConfig, "dedupe" | "archive">;
  /** Phase 999.154 test seam — hashing + archiving (defaults use sharp / node:crypto). */
  readonly imageTools?: {
    readonly sha256: (buf: Buffer) => string;
    readonly dhash: (buf: Buffer) => Promise<string | null>;
    readonly archive: (
      buf: Buffer,
      sourcePath: string,
      dir: string,
      sidePx: number,
    ) => Promise<string | null>;
  };
  /**
   * Phase 999.43-fu2 Path B T05 — high-resolution timing source. Defaults
   * to `performance.now()`. Tests inject a deterministic clock to assert
   * latency budgets without flaky wall-clock dependence.
   */
  readonly perfNow?: () => number;
};

export type AutoIngestSkipResult = {
  readonly ok: true;
  readonly skipped: true;
  readonly reason: string;
};

export type AutoIngestSuccessResult = {
  readonly ok: true;
  readonly skipped: false;
  readonly source: string;
  readonly chunks_created: number;
  readonly content_class: ContentClass;
  readonly agent_weight: number;
  readonly content_weight: number;
};

export type AutoIngestErrorResult = {
  readonly ok: false;
  readonly skipped: false;
  readonly error: string;
};

export type AutoIngestResult =
  | AutoIngestSkipResult
  | AutoIngestSuccessResult
  | AutoIngestErrorResult;

/**
 * Auto-ingest handler. Returns one of three result shapes:
 *   - { ok: true, skipped: true, reason }: flag off OR classifier reject
 *     OR no chunks produced
 *   - { ok: true, skipped: false, ...stats }: dispatched + row written
 *   - { ok: false, skipped: false, error }: engine/embedder/store failure
 *     — NEVER thrown; fire-and-forget caller (bridge.ts) keeps running
 *
 * Throws ManagerError ONLY for missing agent config (unrecoverable —
 * agent name should always resolve to a config row).
 */
export async function handleAutoIngestAttachment(
  params: AutoIngestAttachmentParams,
  deps: AutoIngestHandlerDeps,
): Promise<AutoIngestResult> {
  const {
    agent: agentName,
    file_path: filePath,
    filename,
    mime_type: mimeType,
    size,
    vision_analysis: visionAnalysis,
    channel_id: channelId,
    message_id: messageId,
    user_id: userId,
    user_name: userName,
  } = params;

  const logger = deps.logger;
  const readFileFn = deps.readFileFn ?? readFile;
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());

  const agentConfig = deps.getAgentConfig(agentName);
  if (!agentConfig) {
    throw new ManagerError(
      `Agent config not found for '${agentName}' (auto-ingest)`,
    );
  }

  // D-09 default: agents WITHOUT the flag set preserve current behavior.
  const isTranscript = params.origin === "transcript";
  if (agentConfig.autoIngestAttachments !== true && !isTranscript) {
    logger.info(
      {
        tag: "phase999.43-autoingest",
        agent: agentName,
        channelId,
        messageId,
        userId,
        userName,
        filename,
        mimeType,
        size,
        eligible: false,
        reason: "autoIngestAttachments disabled for agent",
      },
      "phase999.43-autoingest skipped — agent flag off",
    );
    return {
      ok: true,
      skipped: true,
      reason: "autoIngestAttachments disabled for agent",
    };
  }

  // D-01 Axis 1 — agent base priority. Read LIVE; defaults to "medium".
  const agentPriority = agentConfig.ingestionPriority ?? "medium";
  const agentWeight = AGENT_PRIORITY_WEIGHTS[agentPriority];

  // D-01 Axis 2 + D-06 reject — pure-function classifier.
  const classifierOutput = classifyAttachment({
    filename,
    mimeType,
    size,
    visionAnalysis: visionAnalysis ?? undefined,
    clientNamePatterns: undefined,
  });

  if (classifierOutput.eligible === false) {
    logger.info(
      {
        tag: "phase999.43-autoingest",
        agent: agentName,
        channelId,
        messageId,
        userId,
        userName,
        filename,
        mimeType,
        size,
        eligible: false,
        contentClass: classifierOutput.contentClass,
        reason: classifierOutput.reason,
      },
      "phase999.43-autoingest skipped — classifier rejected",
    );
    return {
      ok: true,
      skipped: true,
      reason: classifierOutput.reason,
    };
  }

  let contentClass: ContentClass = isTranscript ? "high" : classifierOutput.contentClass;
  let contentWeight = CONTENT_PRIORITY_WEIGHTS[contentClass];
  let classReason = isTranscript ? "transcript (meeting / voice recording)" : classifierOutput.reason;

  const docStore = deps.getDocumentStore(agentName);
  if (!docStore) {
    const msg = `DocumentStore not found for agent '${agentName}' (auto-ingest)`;
    logger.warn(
      {
        tag: "phase999.43-autoingest",
        agent: agentName,
        messageId,
        eligible: true,
        contentClass,
        error: msg,
      },
      "phase999.43-autoingest dispatch failed",
    );
    return { ok: false, skipped: false, error: msg };
  }

  const source = filePath;

  // Phase 999.43-fu2 T06 — handler-wide duration measurement. Wall-clock
  // from the start of the try block to the success/failure log emit. Closes
  // the latency-review gap: previously the phase999.43-autoingest log line
  // had no timing field, making the ≤5s p95 budget unverifiable.
  const perfNow = deps.perfNow ?? (() => performance.now());
  const handlerStartedAt = perfNow();

  // WP3: retry bookkeeping. A previous attempt that stored only a stub or
  // failed left a row with ingest_status "empty" or "failed"; this attempt
  // counts on from it and keeps that row's provenance when the rescan
  // re-enqueued the file without Discord coordinates.
  let existingRow: DocumentRow | null = null;
  let attempt = 1;

  try {
    existingRow = docStore.getDocumentRow(source);
    attempt = (existingRow?.ingest_attempts ?? 0) + 1;
    const prov = mergeProvenance(params, existingRow, nowIso);
    const headerCtx: DocumentChunkContext = {
      filename:
        filename.trim().length > 0
          ? filename
          : displayFilenameFor(source, existingRow?.filename),
      uploadedAt: prov.ingestedAt,
      userName: prov.userName,
      channelName: prov.channelName,
    };

    const fileBuffer = await readFileFn(filePath);

    const isImageMime =
      typeof mimeType === "string" &&
      mimeType.toLowerCase().startsWith("image/");
    const imageTools = deps.imageTools ?? DEFAULT_IMAGE_TOOLS;
    const ingestCfg = deps.imageIngest ?? IMAGE_INGEST_DEFAULTS;

    // Phase 999.154 — image dedupe + structured vision, BEFORE the OCR engine
    // so an exact re-send costs nothing.
    let contentSha256: string | null = null;
    let imageDhash: string | null = null;
    let analysis: ImageAnalysis | null = null;
    let visionSource: "batch" | "near-dup" | "legacy" | "none" = "none";
    let nearDupOf: string | null = null;
    if (isImageMime) {
      contentSha256 = imageTools.sha256(fileBuffer);
      if (ingestCfg.dedupe.exact) {
        const original = docStore.findDocumentBySha256(contentSha256);
        if (original !== null && original.source !== source) {
          return recordExactDuplicate({
            docStore,
            original,
            params,
            agentWeight,
            contentSha256,
            nowIso,
            logger,
            durationMs: Math.round(perfNow() - handlerStartedAt),
          });
        }
      }

      imageDhash = await imageTools.dhash(fileBuffer);
      if (imageDhash !== null && ingestCfg.dedupe.nearDupHamming > 0) {
        const match = findNearDuplicate(
          docStore,
          source,
          imageDhash,
          ingestCfg.dedupe.nearDupHamming,
          nowIso(),
        );
        if (match !== null) {
          analysis = match.analysis;
          nearDupOf = match.source;
          visionSource = "near-dup";
        }
      }

      if (analysis === null && deps.analyzeImage) {
        try {
          analysis = await deps.analyzeImage(params);
          if (analysis !== null) visionSource = "batch";
        } catch (err) {
          logger.warn(
            {
              tag: "phase999.154-ingest-vision",
              agent: agentName,
              messageId,
              filename,
              err: err instanceof Error ? err.message : String(err),
            },
            "ingest vision failed (non-fatal — OCR text still lands)",
          );
        }
      }

      // Legacy pre-pass text only when it is not a refusal (05-19..09-22 it
      // always was). Structured analysis supersedes it.
      const legacyVision =
        analysis === null &&
        typeof visionAnalysis === "string" &&
        visionAnalysis.length > 0 &&
        !isVisionRefusal(visionAnalysis)
          ? visionAnalysis
          : undefined;
      if (legacyVision !== undefined) visionSource = "legacy";

      const imageClass = classifyAttachment({
        filename,
        mimeType,
        size,
        visionAnalysis: analysis ? renderAnalysisText(analysis) : legacyVision,
        visionImportance: analysis?.importance,
        visionKind: analysis?.kind,
        clientNamePatterns: undefined,
      });
      contentClass = imageClass.contentClass;
      contentWeight = CONTENT_PRIORITY_WEIGHTS[contentClass];
      classReason = imageClass.reason;
    }

    // Phase 101 engine — text-only auto-ingest at v1 (no structured branch).
    const ingestResult = await deps.engine(fileBuffer, filePath, {
      taskHint: undefined,
      backend: undefined,
    });

    // Phase 999.154 — the structured analysis rides in the SAME chunks as the
    // OCR text, so a photo with no text ("the Canyon chain") is retrievable
    // by what it shows, and a chart by its shape.
    let mergedText = ingestResult.text;
    if (analysis !== null) {
      mergedText += `\n\n## Image summary\n${renderAnalysisText(analysis)}`;
      if (analysis.chartShape !== null) {
        mergedText += `\n\n## Chart shape analysis\n${analysis.chartShape}`;
      }
    }

    // WP3: every chunk carries the contextual header (filename, upload date,
    // sender, channel, page, part) in its indexed text. When extraction and
    // the caption both produced nothing, a one-line stub is stored instead of
    // the raw file bytes, and the row is marked "empty" so the rescan retries
    // it at most MAX_INGEST_ATTEMPTS times.
    const pageTexts = Array.isArray(ingestResult.pageTexts)
      ? ingestResult.pageTexts
      : undefined;
    const hasText = mergedText.trim().length > 0;
    const ingestStatus: IngestStatus = hasText ? "ok" : "empty";
    const chunks: readonly ChunkInput[] = hasText
      ? chunkWithContext(mergedText, headerCtx, { pageTexts })
      : [buildEmptyDocumentStub(headerCtx, isImageMime ? "image" : "file")];

    // P1-EMBED-WORKER: embed off the main event loop in the dedicated worker.
    // The document chunks need only v2 (bge int8, the vec_document_chunks
    // column type); the memory mirror below is chunked and embedded
    // separately.
    const chunkTexts = chunks.map((c) => c.content);
    const { v2 } = await deps.embedBoth(chunkTexts, false);

    const result = docStore.ingest(source, chunks, v2);

    // Best-effort cross-ingest into memory_chunks (matches manual path).
    // WP3: the mirror is re-chunked to about 300 words so each row embeds
    // fully, carries the same header, uses the filename as its heading and
    // gets its own v1 + v2 vectors from the worker (crossIngest does no
    // embedding of its own). Stubs are not mirrored. A failure here is
    // repaired later by the rescan's re-mirror pass.
    const memoryStore = deps.getMemoryStore(agentName);
    let memoryChunksWritten = 0;
    try {
      if (memoryStore && ingestStatus === "ok") {
        const mirrorChunks = chunkForMirror(mergedText, headerCtx, pageTexts);
        const mirrorVecs = await deps.embedBoth(
          mirrorChunks.map((c) => c.content),
          true,
        );
        const cross = await crossIngestToMemory({
          agent: agentName,
          docSlug: computeDocSlug(filePath),
          heading: headerCtx.filename,
          chunks: mirrorChunks,
          precomputedV1: mirrorVecs.v1,
          precomputedV2: mirrorVecs.v2,
          memoryStore,
          migrationPhaseStore: new MigrationPhaseStore(memoryStore, agentName),
        });
        memoryChunksWritten = cross.chunksWritten;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(
        {
          tag: "phase999.43-autoingest",
          agent: agentName,
          messageId,
          docSource: source,
          err: msg,
        },
        "phase999.43-autoingest cross-ingest failed (non-fatal)",
      );
    }

    // D-04 provenance write — full field set.
    // Phase 999.43-fu2 Path A — capture the persisted on-disk path for
    // image attachments so retrieval can surface it back (search_documents
    // → agent Read for chart-shape re-look). MIME-driven detection; PDFs and
    // other non-image attachments pass NULL. Pipeline is best-effort: the
    // file path may be reaped by the 24h attachment-cleanup policy
    // (cleanupAttachments in src/discord/attachments.ts).
    // Phase 999.154 WS-4 — durable archived copy; retrieval points at it so
    // the path an agent gets back outlives the 24 h inbox retention.
    // No memoryPath ⇒ no archive (never fall back to a shared /tmp dir).
    const archivePath =
      isImageMime && ingestCfg.archive.enabled && agentConfig.memoryPath
        ? await imageTools.archive(
            fileBuffer,
            filePath,
            attachmentArchiveDir(agentConfig.memoryPath),
            ingestCfg.archive.sidePx,
          )
        : null;
    const sourceImagePath = isImageMime ? (archivePath ?? filePath) : null;
    const row: DocumentRowInput = {
      source,
      agentName,
      channelId: prov.channelId,
      messageId: prov.messageId,
      userId: prov.userId,
      ingestedAt: prov.ingestedAt,
      sourceKind: isTranscript ? "transcript" : "discord_attachment",
      autoClassifiedClass: contentClass,
      overrideClass: null,
      contentWeight,
      agentWeightAtIngest: agentWeight,
      sourceImagePath,
      contentSha256,
      imageDhash,
      visionJson: analysis !== null ? JSON.stringify(analysis) : null,
      filename: headerCtx.filename,
      userName: prov.userName,
      channelName: prov.channelName,
      ingestStatus,
      ingestAttempts: attempt,
    };
    docStore.upsertDocumentRow(row);

    const durationMs = Math.round(perfNow() - handlerStartedAt);
    if (ingestStatus === "empty") {
      const reason =
        `no text could be extracted; stored a stub ` +
        `(attempt ${attempt} of ${MAX_INGEST_ATTEMPTS})`;
      logger.info(
        {
          tag: "phase999.43-autoingest",
          agent: agentName,
          channelId,
          messageId,
          userId,
          userName,
          filename,
          mimeType,
          size,
          eligible: true,
          contentClass,
          agentWeight,
          contentWeight,
          reason,
          chunksCreated: result.chunksCreated,
          docSource: source,
          visionSource,
          attempt,
          durationMs,
        },
        "phase999.43-autoingest stored a stub, no text extracted",
      );
      return { ok: true, skipped: true, reason };
    }
    logger.info(
      {
        tag: "phase999.43-autoingest",
        agent: agentName,
        channelId,
        messageId,
        userId,
        userName,
        filename,
        mimeType,
        size,
        eligible: true,
        contentClass,
        agentWeight,
        contentWeight,
        reason: classReason,
        chunksCreated: result.chunksCreated,
        docSource: source,
        // Phase 999.154 — vision provenance for this document.
        visionSource,
        ...(analysis !== null
          ? { visionKind: analysis.kind, isChart: analysis.isChart }
          : {}),
        ...(nearDupOf !== null ? { nearDupOf } : {}),
        archived: archivePath !== null,
        memoryChunksWritten,
        attempt,
        durationMs,
      },
      "phase999.43-autoingest dispatched",
    );

    return {
      ok: true,
      skipped: false,
      source,
      chunks_created: result.chunksCreated,
      content_class: contentClass,
      agent_weight: agentWeight,
      content_weight: contentWeight,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Math.round(perfNow() - handlerStartedAt);
    logger.warn(
      {
        tag: "phase999.43-autoingest",
        agent: agentName,
        channelId,
        messageId,
        userId,
        userName,
        filename,
        mimeType,
        size,
        eligible: true,
        contentClass,
        agentWeight,
        contentWeight,
        error: msg,
        attempt,
        durationMs,
      },
      "phase999.43-autoingest dispatch failed",
    );
    // WP3: record the failed attempt so the rescan retries it at most
    // MAX_INGEST_ATTEMPTS times instead of every 10 minutes for 24 hours.
    recordFailedAttempt({
      docStore,
      existingRow,
      params,
      attempt,
      contentClass,
      contentWeight,
      agentWeight,
      isTranscript,
      nowIso,
      logger,
    });
    return { ok: false, skipped: false, error: msg };
  }
}

/** Provenance for this attempt: the request's values, else the prior row's. */
type MergedProvenance = {
  readonly channelId: string | null;
  readonly messageId: string | null;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly channelName: string | null;
  readonly ingestedAt: string;
};

/**
 * WP3: a rescan-recovered retry carries empty Discord sentinels; keep the
 * provenance the first attempt recorded instead of overwriting it, and keep
 * the first attempt's ingest date (the upload date the header shows).
 */
function mergeProvenance(
  params: AutoIngestAttachmentParams,
  existing: DocumentRow | null,
  nowIso: () => string,
): MergedProvenance {
  const pick = (
    value: string | undefined,
    prev: string | null | undefined,
  ): string | null => {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof prev === "string" && prev.length > 0) return prev;
    return value ?? null;
  };
  return {
    channelId: pick(params.channel_id, existing?.channel_id),
    messageId: pick(params.message_id, existing?.message_id),
    userId: pick(params.user_id, existing?.user_id),
    userName: pick(params.user_name, existing?.user_name) || null,
    channelName: pick(params.channel_name, existing?.channel_name) || null,
    ingestedAt: existing?.ingested_at ?? nowIso(),
  };
}

/**
 * WP3: persist a failed attempt. An existing row only gets its status and
 * attempt count updated (its chunks and provenance stay); otherwise a
 * chunk-less row is written so the rescan can count attempts. Never throws.
 */
function recordFailedAttempt(args: {
  readonly docStore: DocumentStore;
  readonly existingRow: DocumentRow | null;
  readonly params: AutoIngestAttachmentParams;
  readonly attempt: number;
  readonly contentClass: ContentClass;
  readonly contentWeight: number;
  readonly agentWeight: number;
  readonly isTranscript: boolean;
  readonly nowIso: () => string;
  readonly logger: Logger;
}): void {
  const { docStore, params } = args;
  try {
    if (args.existingRow) {
      docStore.setIngestOutcome(params.file_path, "failed", args.attempt);
      return;
    }
    const prov = mergeProvenance(params, null, args.nowIso);
    docStore.upsertDocumentRow({
      source: params.file_path,
      agentName: params.agent,
      channelId: prov.channelId,
      messageId: prov.messageId,
      userId: prov.userId,
      ingestedAt: prov.ingestedAt,
      sourceKind: args.isTranscript ? "transcript" : "discord_attachment",
      autoClassifiedClass: args.contentClass,
      overrideClass: null,
      contentWeight: args.contentWeight,
      agentWeightAtIngest: args.agentWeight,
      filename: params.filename || null,
      userName: prov.userName,
      channelName: prov.channelName,
      ingestStatus: "failed",
      ingestAttempts: args.attempt,
    });
  } catch (err) {
    args.logger.warn(
      {
        tag: "phase999.43-autoingest",
        agent: params.agent,
        docSource: params.file_path,
        err: err instanceof Error ? err.message : String(err),
      },
      "phase999.43-autoingest could not record the failed attempt",
    );
  }
}

// ---------------------------------------------------------------------------
// Phase 999.154 — image dedupe helpers
// ---------------------------------------------------------------------------

const DEFAULT_IMAGE_TOOLS: NonNullable<AutoIngestHandlerDeps["imageTools"]> = Object.freeze({
  sha256: sha256Hex,
  dhash: dHashHex,
  archive: archiveImage,
});

/** Parse a stored `vision_json` back into an analysis; null when absent/corrupt. */
function parseStoredAnalysis(json: string | null): ImageAnalysis | null {
  if (json === null) return null;
  try {
    const v = JSON.parse(json) as ImageAnalysis;
    return typeof v?.summary === "string" && typeof v?.kind === "string" ? v : null;
  } catch {
    return null;
  }
}

function findNearDuplicate(
  docStore: DocumentStore,
  source: string,
  dhash: string,
  maxHamming: number,
  nowIsoValue: string,
): { readonly source: string; readonly analysis: ImageAnalysis } | null {
  const since = new Date(Date.parse(nowIsoValue) - NEAR_DUP_LOOKBACK_MS).toISOString();
  for (const row of docStore.listRecentImageHashes(since, NEAR_DUP_SCAN_LIMIT)) {
    if (row.source === source) continue;
    if (hammingHex(row.image_dhash, dhash) > maxHamming) continue;
    const analysis = parseStoredAnalysis(row.vision_json);
    if (analysis !== null) return { source: row.source, analysis };
  }
  return null;
}

/**
 * Exact re-send: write a chunk-less provenance row pointing at the original
 * (so the rescan sees this path as handled and never re-enqueues it) and skip
 * OCR, vision and embedding entirely.
 */
function recordExactDuplicate(args: {
  readonly docStore: DocumentStore;
  readonly original: NonNullable<ReturnType<DocumentStore["findDocumentBySha256"]>>;
  readonly params: AutoIngestAttachmentParams;
  readonly agentWeight: number;
  readonly contentSha256: string;
  readonly nowIso: () => string;
  readonly logger: Logger;
  readonly durationMs: number;
}): AutoIngestSkipResult {
  const { original, params } = args;
  args.docStore.upsertDocumentRow({
    source: params.file_path,
    agentName: params.agent,
    channelId: params.channel_id,
    messageId: params.message_id,
    userId: params.user_id,
    ingestedAt: args.nowIso(),
    sourceKind: "discord_attachment",
    autoClassifiedClass: original.auto_classified_class,
    overrideClass: null,
    contentWeight: original.content_priority_weight,
    agentWeightAtIngest: args.agentWeight,
    sourceImagePath: original.source_image_path,
    contentSha256: args.contentSha256,
    duplicateOf: original.source,
    filename: params.filename || null,
    userName: params.user_name || null,
    channelName: params.channel_name || null,
  });
  const reason = `exact duplicate of ${original.source}`;
  args.logger.info(
    {
      tag: "phase999.43-autoingest",
      agent: params.agent,
      channelId: params.channel_id,
      messageId: params.message_id,
      filename: params.filename,
      eligible: true,
      reason,
      duplicateOf: original.source,
      durationMs: args.durationMs,
    },
    "phase999.43-autoingest skipped — exact duplicate",
  );
  return { ok: true, skipped: true, reason };
}
