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
import type {
  DocumentStore,
  DocumentRowInput,
} from "../documents/store.js";
import type { MemoryStore } from "../memory/store.js";
import { chunkText, chunkPdf } from "../documents/chunker.js";
import type { ChunkInput } from "../documents/chunker.js";
import {
  type ingest as IngestEngineFn,
  computeDocSlug,
} from "../document-ingest/index.js";
import {
  crossIngestToMemory,
  MigrationPhaseStore,
} from "../document-ingest/cross-ingest.js";
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

  try {
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

    // Match manual-path chunker cascade over the MERGED text (OCR + image
    // summary + chart shape).
    const chunks: readonly ChunkInput[] =
      mergedText.length > 0
        ? chunkText(mergedText)
        : filePath.endsWith(".pdf")
          ? await chunkPdf(fileBuffer)
          : chunkText(fileBuffer.toString("utf-8"));

    if (chunks.length === 0) {
      // Nothing to embed → no retrievable doc → no provenance row.
      const durationMs = Math.round(perfNow() - handlerStartedAt);
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
          reason: "no chunks produced (empty text)",
          chunksCreated: 0,
          docSource: source,
          visionSource,
          durationMs,
        },
        "phase999.43-autoingest skipped — no chunks",
      );
      return {
        ok: true,
        skipped: true,
        reason: "no chunks produced (empty text)",
      };
    }

    // P1-EMBED-WORKER — embed off the main event loop in the dedicated worker.
    // v2 (bge int8) feeds docStore.ingest AND crossIngest's v2 write; v1 (MiniLM
    // float32) is computed only when cross-ingest will run (memoryStore present),
    // since crossIngest writes the v1 vec row unconditionally. Fetch memoryStore
    // first so it drives `includeV1`.
    const memoryStore = deps.getMemoryStore(agentName);
    const chunkTexts = chunks.map((c) => c.content);
    const { v1, v2 } = await deps.embedBoth(chunkTexts, memoryStore != null);

    const result = docStore.ingest(source, chunks, v2);

    // Best-effort cross-ingest into memory_chunks (matches manual path).
    // P1-CROSSINGEST — pass the SAME precomputed embeddings; crossIngest does no
    // embedding of its own (no second resident ONNX model copy on the main loop).
    try {
      if (memoryStore) {
        await crossIngestToMemory({
          agent: agentName,
          docSlug: computeDocSlug(filePath),
          chunks: chunks.map((c, i) => ({ index: i, content: c.content })),
          precomputedV1: v1,
          precomputedV2: v2,
          memoryStore,
          migrationPhaseStore: new MigrationPhaseStore(memoryStore, agentName),
        });
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
      channelId,
      messageId,
      userId,
      ingestedAt: nowIso(),
      sourceKind: isTranscript ? "transcript" : "discord_attachment",
      autoClassifiedClass: contentClass,
      overrideClass: null,
      contentWeight,
      agentWeightAtIngest: agentWeight,
      sourceImagePath,
      contentSha256,
      imageDhash,
      visionJson: analysis !== null ? JSON.stringify(analysis) : null,
    };
    docStore.upsertDocumentRow(row);

    const durationMs = Math.round(perfNow() - handlerStartedAt);
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
        durationMs,
      },
      "phase999.43-autoingest dispatch failed",
    );
    return { ok: false, skipped: false, error: msg };
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
