/**
 * Phase 61 Plan 01 Task 3 -- Webhook HTTP handler.
 *
 * Pure HTTP handler for `/webhook/<triggerId>` requests. Extracted from
 * the dashboard server for single-responsibility and testability.
 *
 * Flow: buffer raw body -> check size -> verify HMAC-SHA256 -> parse JSON
 * -> call ingestFn with raw bytes for stable idempotency key derivation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "pino";

/**
 * Per-webhook trigger configuration needed by the handler.
 */
export type WebhookConfig = Readonly<{
  triggerId: string;
  secret: string;
  targetAgent: string;
  maxBodyBytes: number;
}>;

/**
 * Callback invoked on successful HMAC verification and JSON parse.
 * Receives triggerId, parsed payload, AND raw body bytes. The raw bytes
 * are needed by WebhookSource.handleHttp to derive a stable idempotency
 * key (SHA-256 of body). Without raw bytes, the caller would need to
 * re-serialize the parsed JSON, which may not produce identical bytes.
 */
export type WebhookIngestFn = (
  triggerId: string,
  payload: unknown,
  rawBodyBytes: Buffer,
) => Promise<void>;

/**
 * Send a JSON response. Duplicated from server.ts (not exported there).
 */
function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Buffer the full request body, enforcing a size limit.
 * Returns null if the body exceeds the limit (response already sent).
 */
function bufferBody(
  req: IncomingMessage,
  maxBytes: number,
  res: ServerResponse,
): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let aborted = false;

    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        aborted = true;
        sendJson(res, 413, { error: "Body exceeds size limit" });
        if (typeof (req as any).destroy === "function") {
          (req as any).destroy();
        }
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!aborted) {
        resolve(Buffer.concat(chunks));
      }
    });

    req.on("error", () => {
      if (!aborted) {
        sendJson(res, 500, { error: "Request read error" });
        resolve(null);
      }
    });
  });
}

/**
 * Create a webhook handler function bound to a set of trigger configs.
 *
 * The returned function handles a single webhook request:
 * 1. Lookup triggerId in configs. 404 if not found.
 * 2. Buffer raw body (413 if exceeds maxBodyBytes).
 * 3. Check x-signature-256 header (401 if missing).
 * 4. Verify HMAC-SHA256 with timingSafeEqual (403 if mismatch).
 * 5. Parse JSON (400 if invalid).
 * 6. Call ingestFn(triggerId, payload, rawBodyBytes).
 * 7. Respond 200.
 */
export function createWebhookHandler(
  configs: ReadonlyMap<string, WebhookConfig>,
  ingestFn: WebhookIngestFn,
  log: Logger,
): (triggerId: string, req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (triggerId, req, res) => {
    // Step 1: Lookup config
    const config = configs.get(triggerId);
    if (!config) {
      sendJson(res, 404, { error: "Unknown trigger" });
      return;
    }

    // Step 2: Buffer body with size limit
    const rawBody = await bufferBody(req, config.maxBodyBytes, res);
    if (rawBody === null) {
      return; // 413 already sent
    }

    // Step 3: Check signature header
    const sigHeader = req.headers["x-signature-256"] as string | undefined;
    if (!sigHeader) {
      sendJson(res, 401, { error: "Missing signature" });
      return;
    }

    // Step 4: Verify HMAC-SHA256 with timing-safe comparison
    const expectedSig =
      "sha256=" + createHmac("sha256", config.secret).update(rawBody).digest("hex");
    const sigBuffer = Buffer.from(sigHeader, "utf-8");
    const expectedBuffer = Buffer.from(expectedSig, "utf-8");

    if (
      sigBuffer.length !== expectedBuffer.length ||
      !timingSafeEqual(sigBuffer, expectedBuffer)
    ) {
      log.warn(
        { triggerId },
        "webhook-handler: invalid HMAC signature",
      );
      sendJson(res, 403, { error: "Invalid signature" });
      return;
    }

    // Step 5: Parse JSON
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf-8"));
    } catch {
      sendJson(res, 400, { error: "Invalid JSON" });
      return;
    }

    // Step 6: Ingest
    try {
      await ingestFn(triggerId, payload, rawBody);
    } catch (err) {
      log.error(
        { triggerId, error: (err as Error).message },
        "webhook-handler: ingest error",
      );
      sendJson(res, 500, { error: "Ingest failed" });
      return;
    }

    // Step 7: Success
    sendJson(res, 200, { ok: true });
  };
}
