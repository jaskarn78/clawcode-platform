/**
 * Quick task 260419-mvh Task 2 — JSONL request logger for the OpenAI endpoint.
 *
 * Writes one JSON line per request (`/v1/chat/completions` and `/v1/models`)
 * to `${dir}/openai-requests-YYYY-MM-DD.jsonl` (UTC date for consistent
 * rollover boundaries across operator timezones).
 *
 * Design decisions (deliberately minimal — this is a diagnostic feed, not a
 * billing source of truth):
 *
 *   - SYNCHRONOUS writes via `fs.appendFileSync`. At ≤ dozens of req/min on a
 *     daemon with one HTTP listener, the 100–500µs cost per write is noise
 *     versus the complexity of an async queue. Trade-off: the handler's
 *     `res.on('close')` path blocks for one disk write. Acceptable.
 *
 *   - FAILS SILENT. fs errors (ENOSPC, EACCES, EIO) are caught and rate-
 *     limited to 1 warn/min via the injected logger. `logger.log(record)`
 *     NEVER throws — an observability feed must not break request handling.
 *
 *   - BEARER PREFIX is ONLY the first 12 chars of the raw incoming key.
 *     Callers (server.ts) are responsible for slicing before handing in —
 *     we do not accept the full key. This keeps the redaction boundary clear.
 *
 *   - MESSAGE BODIES are stripped by default. `includeBodies: true` (set via
 *     the CLAWCODE_OPENAI_LOG_BODIES env var at bootstrap) captures the raw
 *     messages array verbatim. Prompts contain PII and user intent — strip
 *     by default, opt-in per-operator.
 *
 *   - DIR is created on first write (recursive) so operators don't have to
 *     pre-create ~/.clawcode/manager/.
 *
 *   - FILENAME uses UTC ISO date (slice(0, 10) of toISOString). Calendar-day
 *     rollover is the minimum consistent boundary across N operators in N
 *     timezones.
 *
 *   - close() is a no-op — sync writes don't queue. Declared async to leave
 *     room for a future batched/async implementation without breaking callers.
 */
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";

/** One record per request. All fields either populated or null/undefined. */
export interface RequestLogRecord {
  readonly request_id: string;
  readonly timestamp_iso: string;          // new Date().toISOString()
  readonly method: string;                 // GET / POST / OPTIONS
  readonly path: string;                   // e.g. /v1/chat/completions
  readonly agent: string | null;           // null pre-auth and for /models
  readonly model: string | null;           // body.model when parsed
  readonly stream: boolean | null;         // null for GET /v1/models
  readonly status_code: number;
  readonly ttfb_ms: number | null;         // stream-only, first-chunk latency
  readonly total_ms: number;               // request-start → response-end
  readonly bearer_key_prefix: string | null;   // first 12 chars of incoming key
  readonly messages_count: number | null;  // null when body absent / no messages
  readonly response_bytes: number;         // best-effort (Content-Length or 0)
  readonly error_type: string | null;      // OpenAI error.type on 4xx/5xx
  readonly error_code: string | null;      // OpenAI error.code on 4xx/5xx
  readonly finish_reason: string | null;   // from translator.finalize() (stream/non-stream)
  /** Present iff includeBodies=true — stripped by default (PII / prompt content). */
  readonly messages?: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  /** Raw pre-validation request body (stamped on 400 body_validation_error for diagnostics). Same PII gate as `messages`. */
  readonly raw_body?: Readonly<Record<string, unknown>>;
}

export interface RequestLogger {
  /** Non-blocking — swallows fs errors, NEVER throws. */
  log(record: RequestLogRecord): void;
  /** Future-proofing — currently a no-op (sync writes don't queue). */
  close(): Promise<void>;
}

export interface CreateRequestLoggerOpts {
  readonly dir: string;
  readonly includeBodies?: boolean;         // default false
  readonly clock?: () => Date;              // injected for tests
  readonly log: Logger;                     // warn-on-write-failure only
  /**
   * Injected appender for tests that need to simulate fs failures. ESM
   * namespace imports can't be spied via `vi.spyOn(fs, "appendFileSync")`,
   * so production uses `appendFileSync` via closure and tests inject a
   * throwing stub. Default: node:fs appendFileSync.
   */
  readonly appender?: (path: string, data: string) => void;
}

/** Rate-limit fs-error warnings so 1000 EACCES calls produce 1 log line, not 1000. */
const WARN_THROTTLE_MS = 60_000;

export function createRequestLogger(opts: CreateRequestLoggerOpts): RequestLogger {
  const clock = opts.clock ?? (() => new Date());
  const includeBodies = opts.includeBodies === true;
  const appender = opts.appender ?? ((p, data) => appendFileSync(p, data));
  let lastWarnAt = 0;

  function ensureDir(): void {
    if (!existsSync(opts.dir)) {
      mkdirSync(opts.dir, { recursive: true });
    }
  }

  function todayUtcIso(): string {
    return clock().toISOString().slice(0, 10);
  }

  function filePath(): string {
    return join(opts.dir, `openai-requests-${todayUtcIso()}.jsonl`);
  }

  /**
   * Returns a NEW record with `messages` and `raw_body` stripped when
   * includeBodies=false. Immutable by contract — never mutates the caller's
   * record (coding-style.md).
   */
  function redact(record: RequestLogRecord): RequestLogRecord {
    if (includeBodies) return record;
    const anyRec = record as RequestLogRecord & {
      messages?: unknown;
      raw_body?: unknown;
    };
    if (anyRec.messages === undefined && anyRec.raw_body === undefined) {
      return record;
    }
    const { messages: _om1, raw_body: _om2, ...rest } = anyRec;
    return rest as RequestLogRecord;
  }

  function maybeWarn(err: Error): void {
    const now = clock().getTime();
    if (now - lastWarnAt < WARN_THROTTLE_MS) return;
    lastWarnAt = now;
    // Keep the warn minimal — do NOT include the record (could contain a
    // bearer-key prefix). Include the dir for operator debugging (the dir
    // is a project path, not a secret).
    opts.log.warn(
      { err: err.message, dir: opts.dir },
      "openai request logger: write failed (rate-limited, 1/min)",
    );
  }

  return {
    log(record) {
      try {
        ensureDir();
        const line = JSON.stringify(redact(record)) + "\n";
        appender(filePath(), line);
      } catch (err) {
        try {
          maybeWarn(err as Error);
        } catch {
          // Absolute last-resort — the logger itself failed. Stay silent.
          // Tests assert log() never throws.
        }
      }
    },
    async close() {
      // Sync appendFileSync has no queue. close() exists for future-proofing
      // in case this module switches to an async write queue.
    },
  };
}
