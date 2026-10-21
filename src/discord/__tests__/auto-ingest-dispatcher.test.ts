/**
 * Phase 999.43 Plan 02 T03 — integration test for the auto-ingest dispatcher.
 *
 * Exercises `handleAutoIngestAttachment` (extracted from the daemon switch
 * per the memory-lookup-handler.ts precedent — Phase 68-02) against:
 *   - Test 1 (skip path): autoIngestAttachments=false → { skipped: true },
 *     reason matches /disabled/, NO documents row, engine NOT called.
 *   - Test 2 (reject path): autoIngestAttachments=true + filename "movie.mp4"
 *     → { skipped: true }, reason matches /video/, NO documents row.
 *   - Test 3 (happy path, content HIGH): autoIngestAttachments=true,
 *     ingestionPriority="high", filename "client-c-2024-return.pdf" size 250_000
 *     mime "application/pdf" → engine called, docStore.ingest called,
 *     documents row written with auto_classified_class="high",
 *     content_priority_weight=1.5, agent_priority_weight_at_ingest=1.5,
 *     source_kind="discord_attachment", all D-04 provenance fields populated.
 *   - Test 4 (telemetry shape): same as Test 3 — capture log records and
 *     assert ONE info-level entry with tag "phase999.43-autoingest",
 *     eligible:true, contentClass:"high", agentWeight:1.5, contentWeight:1.5.
 *
 * Uses a real `:memory:` DocumentStore (Plan 01 T02) so the upsertDocumentRow
 * call writes a real row we can SELECT back. Engine + embedder are stubbed
 * so the test runs in < 5s with no I/O beyond the in-memory sqlite db.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Writable } from "node:stream";
import pino from "pino";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";

import { handleAutoIngestAttachment } from "../../manager/auto-ingest-handler.js";
import type {
  AutoIngestAttachmentParams,
  AutoIngestHandlerDeps,
} from "../../manager/auto-ingest-handler.js";
import {
  DocumentStore,
  type DocumentRow,
} from "../../documents/store.js";
import type { ResolvedAgentConfig } from "../../shared/types.js";
import type { ingest as IngestEngineFn } from "../../document-ingest/index.js";
import type { MemoryStore } from "../../memory/store.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDb(): DatabaseType {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  sqliteVec.load(db);
  return db;
}

function captureLogger(): {
  log: pino.Logger;
  records: () => Array<Record<string, unknown>>;
} {
  const chunks: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });
  const log = pino({ level: "debug" }, sink);
  const records = () =>
    chunks
      .join("")
      .split("\n")
      .filter((s) => s.length > 0)
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  return { log, records };
}

function makeAgent(
  overrides: Partial<ResolvedAgentConfig> & { name: string },
): ResolvedAgentConfig {
  // Mirror the slash-commands test factories — cast through `unknown` rather
  // than fabricating every nested zod-default. Handler only reads
  // `autoIngestAttachments` + `ingestionPriority` from this surface.
  return {
    name: overrides.name,
    workspace: `/tmp/${overrides.name}`,
    soulFile: `/tmp/${overrides.name}/SOUL.md`,
    identityFile: `/tmp/${overrides.name}/IDENTITY.md`,
    model: "sonnet",
    channels: [],
    soul: "",
    schedules: [],
    slashCommands: [],
    heartbeat: false,
    admin: false,
    effort: "low",
    reactions: true,
    mcpServers: [],
    autoIngestAttachments: overrides.autoIngestAttachments,
    ingestionPriority: overrides.ingestionPriority,
  } as unknown as ResolvedAgentConfig;
}

function stubEmbedBoth(): AutoIngestHandlerDeps["embedBoth"] {
  // P1-EMBED-WORKER — the handler now embeds via deps.embedBoth (the worker
  // client) instead of getEmbedder().embedV2. Return index-aligned stubs:
  // v2 (int8, 384-dim) always; v1 (float32, 384-dim) only when includeV1.
  return async (texts, includeV1) => ({
    v2: texts.map(() => new Int8Array(384)),
    v1: includeV1 ? texts.map(() => new Float32Array(384)) : null,
  });
}

function makeStubEngine(text: string): typeof IngestEngineFn {
  return (async (_buf: Buffer, filename: string) => {
    return {
      text,
      pages: [],
      telemetry: {
        docSlug: filename.replace(/\.[^.]+$/, ""),
        type: "pdf" as const,
        pages: 1,
        ocrUsed: "none" as const,
        chunksCreated: 0,
        p50_ms: 0,
        p95_ms: 0,
        ocr_p50_ms: 0,
        ocr_p95_ms: 0,
        total_ms: 0,
      },
    };
  }) as unknown as typeof IngestEngineFn;
}

function makeDeps(opts: {
  db: DatabaseType;
  agentConfig: ResolvedAgentConfig | undefined;
  log: pino.Logger;
  engineText?: string;
  readFileFn?: AutoIngestHandlerDeps["readFileFn"];
  // Phase 999.154 — batched vision for image attachments (replaces the
  // per-image chart pass). Absent ⇒ no vision (OCR-only).
  analyzeImage?: AutoIngestHandlerDeps["analyzeImage"];
}): {
  deps: AutoIngestHandlerDeps;
  docStore: DocumentStore;
  callCounts: { engine: number; ingest: number; upsert: number };
} {
  const docStore = new DocumentStore(opts.db);
  const callCounts = { engine: 0, ingest: 0, upsert: 0 };
  // Wrap docStore methods to count calls.
  const realIngest = docStore.ingest.bind(docStore);
  docStore.ingest = (...args) => {
    callCounts.ingest++;
    return realIngest(...args);
  };
  const realUpsert = docStore.upsertDocumentRow.bind(docStore);
  docStore.upsertDocumentRow = (row) => {
    callCounts.upsert++;
    return realUpsert(row);
  };

  const engineText = opts.engineText ?? "Synthetic Client C 2024 tax return body.";
  const engine = makeStubEngine(engineText);
  const engineWrapped: typeof IngestEngineFn = (async (
    ...args: Parameters<typeof IngestEngineFn>
  ): Promise<ReturnType<typeof IngestEngineFn>> => {
    callCounts.engine++;
    return await (
      engine as unknown as (
        ...a: Parameters<typeof IngestEngineFn>
      ) => ReturnType<typeof IngestEngineFn>
    )(...args);
  }) as unknown as typeof IngestEngineFn;

  const deps: AutoIngestHandlerDeps = {
    getDocumentStore: (a: string) =>
      a === opts.agentConfig?.name ? docStore : undefined,
    getMemoryStore: (_a: string) => undefined as unknown as MemoryStore,
    embedBoth: stubEmbedBoth(),
    getAgentConfig: (a: string) =>
      a === opts.agentConfig?.name ? opts.agentConfig : undefined,
    logger: opts.log,
    engine: engineWrapped,
    readFileFn: opts.readFileFn ?? (async () => Buffer.from("synthetic")),
    nowIso: () => "2026-05-16T20:00:00.000Z",
    analyzeImage: opts.analyzeImage,
  };
  return { deps, docStore, callCounts };
}

function makeParams(
  overrides: Partial<AutoIngestAttachmentParams> = {},
): AutoIngestAttachmentParams {
  return {
    agent: "fin-client",
    file_path: "/tmp/fin-client/inbox/attachments/client-c-2024-return.pdf",
    filename: "client-c-2024-return.pdf",
    mime_type: "application/pdf",
    size: 250_000,
    vision_analysis: null,
    channel_id: "1234567890",
    message_id: "9876543210",
    user_id: "1112223334",
    user_name: "operator",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("auto-ingest dispatcher — Phase 999.43 Plan 02 T03", () => {
  let db: DatabaseType;

  beforeEach(() => {
    db = freshDb();
  });

  it("Test 1 (skip path): autoIngestAttachments=false → skipped, no row, no engine call", async () => {
    const { log, records } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: false,
    });
    const { deps, docStore, callCounts } = makeDeps({ db, agentConfig, log });

    const result = await handleAutoIngestAttachment(makeParams(), deps);

    expect(result.ok).toBe(true);
    if (!("skipped" in result) || !result.skipped) {
      throw new Error("expected skipped result");
    }
    expect(result.reason).toMatch(/disabled/i);
    expect(callCounts.engine).toBe(0);
    expect(callCounts.ingest).toBe(0);
    expect(callCounts.upsert).toBe(0);
    // Confirm no documents row exists.
    expect(docStore.getDocumentRow(makeParams().file_path)).toBeNull();
    // Log assertion — one info line with eligible:false + reason.
    const recs = records();
    const skipLog = recs.find(
      (r) =>
        r.tag === "phase999.43-autoingest" &&
        r.eligible === false &&
        typeof r.reason === "string" &&
        /disabled/i.test(r.reason as string),
    );
    expect(skipLog).toBeDefined();
  });

  it("Test 2 (reject path): video filename → skipped, no row, classifier reason cites video", async () => {
    const { log } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: true,
      ingestionPriority: "high",
    });
    const { deps, docStore, callCounts } = makeDeps({ db, agentConfig, log });

    const params = makeParams({
      filename: "movie.mp4",
      mime_type: "video/mp4",
      file_path: "/tmp/fin-client/inbox/attachments/movie.mp4",
    });
    const result = await handleAutoIngestAttachment(params, deps);

    expect(result.ok).toBe(true);
    if (!("skipped" in result) || !result.skipped) {
      throw new Error("expected skipped result");
    }
    expect(result.reason).toMatch(/video/i);
    expect(callCounts.engine).toBe(0);
    expect(callCounts.upsert).toBe(0);
    expect(docStore.getDocumentRow(params.file_path)).toBeNull();
  });

  it("Test 3 (happy path, HIGH × HIGH): engine + ingest + provenance row with D-04 fields + D-01 weights", async () => {
    const { log } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: true,
      ingestionPriority: "high",
    });
    const { deps, docStore, callCounts } = makeDeps({ db, agentConfig, log });

    const params = makeParams();
    const result = await handleAutoIngestAttachment(params, deps);

    expect(result.ok).toBe(true);
    // Narrow: success result has ok:true AND skipped:false. Error has ok:false.
    if (result.ok !== true || result.skipped !== false) {
      throw new Error(
        `expected non-skipped success; got ${JSON.stringify(result)}`,
      );
    }
    expect(result.source).toBe(params.file_path);
    expect(result.content_class).toBe("high");
    expect(result.agent_weight).toBe(1.5);
    expect(result.content_weight).toBe(1.5);
    expect(result.chunks_created).toBeGreaterThan(0);

    expect(callCounts.engine).toBe(1);
    expect(callCounts.ingest).toBe(1);
    expect(callCounts.upsert).toBe(1);

    // Verify the documents row carries every D-04 field.
    const row = docStore.getDocumentRow(params.file_path) as DocumentRow | null;
    expect(row).not.toBeNull();
    if (row === null) throw new Error("row was null");
    expect(row.source).toBe(params.file_path);
    expect(row.agent_name).toBe("fin-client");
    expect(row.channel_id).toBe("1234567890");
    expect(row.message_id).toBe("9876543210");
    expect(row.user_id).toBe("1112223334");
    expect(row.ingested_at).toBe("2026-05-16T20:00:00.000Z");
    expect(row.source_kind).toBe("discord_attachment");
    expect(row.auto_classified_class).toBe("high");
    expect(row.override_class).toBeNull();
    // D-01 LOCKED axis multipliers: 1.5 (axis 2 HIGH) × 1.5 (axis 1 HIGH).
    expect(row.content_priority_weight).toBe(1.5);
    expect(row.agent_priority_weight_at_ingest).toBe(1.5);
  });

  it("Test 5 (fu2 T02 — image): image mime → documents row carries source_image_path = file_path", async () => {
    const { log } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: true,
      ingestionPriority: "high",
    });
    // Synthetic bytes don't decode, so the archive + dHash steps return
    // null and source_image_path falls back to the inbox path.
    const { deps, docStore } = makeDeps({
      db,
      agentConfig,
      log,
      engineText: "OCR text from chart image.",
      analyzeImage: async () => null,
    });

    const params = makeParams({
      filename: "aapl-candle-2026-05-17.png",
      mime_type: "image/png",
      file_path:
        "/tmp/fin-client/inbox/attachments/aapl-candle-2026-05-17.png",
      size: 240_000,
    });
    const result = await handleAutoIngestAttachment(params, deps);
    expect(result.ok).toBe(true);

    const row = docStore.getDocumentRow(params.file_path);
    expect(row).not.toBeNull();
    expect(row!.source_image_path).toBe(params.file_path);
  });

  it("Test 6 (fu2 T02 — PDF): PDF mime → source_image_path stored as NULL", async () => {
    const { log } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: true,
      ingestionPriority: "high",
    });
    const { deps, docStore } = makeDeps({ db, agentConfig, log });

    const params = makeParams(); // default = PDF mime
    const result = await handleAutoIngestAttachment(params, deps);
    expect(result.ok).toBe(true);

    const row = docStore.getDocumentRow(params.file_path);
    expect(row).not.toBeNull();
    expect(row!.source_image_path).toBeNull();
  });

  it("Test 4 (telemetry): single info-level phase999.43-autoingest log line on happy path", async () => {
    const { log, records } = captureLogger();
    const agentConfig = makeAgent({
      name: "fin-client",
      autoIngestAttachments: true,
      ingestionPriority: "high",
    });
    const { deps } = makeDeps({ db, agentConfig, log });

    await handleAutoIngestAttachment(makeParams(), deps);

    const recs = records();
    // Filter to dispatched-success logs (eligible:true, contentClass set).
    const dispatched = recs.filter(
      (r) =>
        r.tag === "phase999.43-autoingest" &&
        r.eligible === true &&
        r.contentClass === "high",
    );
    expect(dispatched).toHaveLength(1);
    const entry = dispatched[0];
    expect(entry.level).toBe(30); // pino info-level numeric
    expect(entry.agentWeight).toBe(1.5);
    expect(entry.contentWeight).toBe(1.5);
    expect(entry.agent).toBe("fin-client");
    expect(entry.messageId).toBe("9876543210");
    expect(entry.channelId).toBe("1234567890");
    expect(entry.userId).toBe("1112223334");
    expect(entry.userName).toBe("operator");
    expect(entry.filename).toBe("client-c-2024-return.pdf");
    expect(entry.mimeType).toBe("application/pdf");
    expect(entry.size).toBe(250_000);
    expect(typeof entry.chunksCreated).toBe("number");
    expect(entry.chunksCreated).toBeGreaterThan(0);
    expect(typeof entry.reason).toBe("string");
    // Phase 999.43-fu2 T06 — emit shape includes the new durationMs field.
    expect(typeof entry.durationMs).toBe("number");
    expect((entry.durationMs as number)).toBeGreaterThanOrEqual(0);
  });
});
