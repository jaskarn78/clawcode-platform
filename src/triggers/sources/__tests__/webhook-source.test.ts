/**
 * Phase 61 Plan 01 Task 3 -- WebhookSource + webhook HTTP handler tests.
 *
 * Tests HMAC-SHA256 signature verification, body size limits, stable
 * idempotency key generation, and the WebhookSource adapter lifecycle.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";

import { WebhookSource } from "../webhook-source.js";
import {
  createWebhookHandler,
  type WebhookConfig,
  type WebhookIngestFn,
} from "../../../dashboard/webhook-handler.js";
import type { TriggerEvent } from "../../types.js";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

/**
 * Build a mock IncomingMessage that emits body data.
 */
function mockReq(
  bodyStr: string,
  headers: Record<string, string> = {},
): EventEmitter & { headers: Record<string, string>; method: string; destroy: () => void } {
  const req = new EventEmitter() as any;
  req.headers = headers;
  req.method = "POST";
  req.destroy = vi.fn();
  // Schedule data emission in next microtask
  queueMicrotask(() => {
    req.emit("data", Buffer.from(bodyStr));
    req.emit("end");
  });
  return req;
}

/**
 * Build a mock ServerResponse that captures status and written data.
 */
function mockRes() {
  const chunks: Buffer[] = [];
  const res = {
    statusCode: 0,
    headers: {} as Record<string, string | number>,
    writeHead: vi.fn((status: number, headers?: Record<string, string | number>) => {
      res.statusCode = status;
      if (headers) Object.assign(res.headers, headers);
    }),
    end: vi.fn((data?: string | Buffer) => {
      if (data) chunks.push(Buffer.from(data as string));
    }),
  };
  return { res: res as any, getBody: () => Buffer.concat(chunks).toString() };
}

function signBody(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// ---------------------------------------------------------------------------
// Webhook HTTP handler tests
// ---------------------------------------------------------------------------

describe("createWebhookHandler", () => {
  let ingestFn: ReturnType<typeof vi.fn<WebhookIngestFn>>;
  let log: ReturnType<typeof makeLog>;
  let configs: Map<string, WebhookConfig>;
  let handler: ReturnType<typeof createWebhookHandler>;

  beforeEach(() => {
    ingestFn = vi.fn<WebhookIngestFn>().mockResolvedValue(undefined);
    log = makeLog();
    configs = new Map([
      [
        "gh-push",
        {
          triggerId: "gh-push",
          secret: "test-secret-123",
          targetAgent: "studio",
          maxBodyBytes: 65536,
        },
      ],
    ]);
    handler = createWebhookHandler(configs, ingestFn, log);
  });

  // Test 1: valid HMAC returns 200 and calls ingestFn
  it("returns 200 and calls ingestFn with valid HMAC signature", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const sig = signBody(body, "test-secret-123");
    const req = mockReq(body, { "x-signature-256": sig });
    const { res, getBody } = mockRes();

    await handler("gh-push", req as any, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(getBody())).toEqual({ ok: true });
    expect(ingestFn).toHaveBeenCalledTimes(1);
    const [triggerId, payload, rawBytes] = ingestFn.mock.calls[0]!;
    expect(triggerId).toBe("gh-push");
    expect(payload).toEqual({ ref: "refs/heads/main" });
    expect(Buffer.isBuffer(rawBytes)).toBe(true);
  });

  // Test 2: missing X-Signature-256 returns 401
  it("returns 401 when X-Signature-256 header is missing", async () => {
    const body = JSON.stringify({ data: "test" });
    const req = mockReq(body, {});
    const { res } = mockRes();

    await handler("gh-push", req as any, res);

    expect(res.statusCode).toBe(401);
    expect(ingestFn).not.toHaveBeenCalled();
  });

  // Test 3: invalid HMAC returns 403
  it("returns 403 when HMAC signature is invalid", async () => {
    const body = JSON.stringify({ data: "test" });
    const req = mockReq(body, { "x-signature-256": "sha256=deadbeef" });
    const { res } = mockRes();

    await handler("gh-push", req as any, res);

    expect(res.statusCode).toBe(403);
    expect(ingestFn).not.toHaveBeenCalled();
  });

  // Test 4: body exceeding maxBodyBytes returns 413
  it("returns 413 when body exceeds maxBodyBytes", async () => {
    // Create a config with tiny maxBodyBytes
    const smallConfigs = new Map([
      [
        "small",
        {
          triggerId: "small",
          secret: "sec",
          targetAgent: "a",
          maxBodyBytes: 10,
        },
      ],
    ]);
    const smallHandler = createWebhookHandler(smallConfigs, ingestFn, log);

    const body = "a".repeat(20);
    const sig = signBody(body, "sec");
    const req = mockReq(body, { "x-signature-256": sig });
    const { res } = mockRes();

    await smallHandler("small", req as any, res);

    expect(res.statusCode).toBe(413);
    expect(ingestFn).not.toHaveBeenCalled();
  });

  // Test 5: unknown triggerId returns 404
  it("returns 404 for unknown triggerId", async () => {
    const body = JSON.stringify({});
    const req = mockReq(body, {});
    const { res } = mockRes();

    await handler("unknown-trigger", req as any, res);

    expect(res.statusCode).toBe(404);
    expect(ingestFn).not.toHaveBeenCalled();
  });

  // Test 9: HMAC uses timingSafeEqual (structural verification via source grep)
  // This is verified by acceptance criteria grep, not runtime test.

  // Test 10: body is buffered before HMAC verification then parsed
  it("buffers body before HMAC verification, then parses as JSON", async () => {
    const body = JSON.stringify({ key: "value" });
    const sig = signBody(body, "test-secret-123");
    const req = mockReq(body, { "x-signature-256": sig });
    const { res } = mockRes();

    await handler("gh-push", req as any, res);

    // If body wasn't buffered before HMAC check, the comparison would fail
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// WebhookSource tests
// ---------------------------------------------------------------------------

describe("WebhookSource", () => {
  let ingestFn: ReturnType<typeof vi.fn<(event: TriggerEvent) => Promise<void>>>;
  let log: ReturnType<typeof makeLog>;

  beforeEach(() => {
    ingestFn = vi.fn<(event: TriggerEvent) => Promise<void>>().mockResolvedValue(undefined);
    log = makeLog();
  });

  function makeSource() {
    return new WebhookSource({
      configs: [
        {
          triggerId: "gh-push",
          secret: "test-secret-123",
          targetAgent: "studio",
          maxBodyBytes: 65536,
        },
      ],
      ingest: ingestFn,
      log,
    });
  }

  // Test 6: start() is a no-op
  it("start() is a no-op (event-driven, not polling)", () => {
    const source = makeSource();
    // Should not throw
    source.start();
  });

  // Test 7: stop() is a no-op
  it("stop() is a no-op", () => {
    const source = makeSource();
    source.stop();
  });

  // Test 8: no poll() method
  it("has no poll() method (webhooks are push, not pollable)", () => {
    const source = makeSource();
    expect((source as any).poll).toBeUndefined();
  });

  // Test 11: handleHttp generates idempotency key from X-Webhook-ID header
  it("handleHttp generates idempotency key from webhookId when present", async () => {
    const source = makeSource();
    const rawBody = Buffer.from(JSON.stringify({ ref: "main" }));

    await source.handleHttp("gh-push", { ref: "main" }, rawBody, "delivery-123");

    expect(ingestFn).toHaveBeenCalledTimes(1);
    const event: TriggerEvent = ingestFn.mock.calls[0]![0];
    expect(event.idempotencyKey).toBe("wh:gh-push:delivery-123");
  });

  // Test 12: handleHttp generates idempotency key from SHA-256 of raw body when no webhookId
  it("handleHttp generates idempotency key from SHA-256 of raw body when no webhookId", async () => {
    const source = makeSource();
    const rawBody = Buffer.from(JSON.stringify({ ref: "main" }));

    await source.handleHttp("gh-push", { ref: "main" }, rawBody);

    expect(ingestFn).toHaveBeenCalledTimes(1);
    const event: TriggerEvent = ingestFn.mock.calls[0]![0];
    // Key should start with wh:gh-push: and have a hex hash portion
    expect(event.idempotencyKey).toMatch(/^wh:gh-push:[a-f0-9]{16}$/);
  });

  // Test 13: two calls with same body produce identical idempotency keys
  it("two calls with same raw body produce identical idempotency keys (dedup works)", async () => {
    const source = makeSource();
    const rawBody = Buffer.from(JSON.stringify({ ref: "main" }));

    await source.handleHttp("gh-push", { ref: "main" }, rawBody);
    await source.handleHttp("gh-push", { ref: "main" }, rawBody);

    const key1: string = ingestFn.mock.calls[0]![0].idempotencyKey;
    const key2: string = ingestFn.mock.calls[1]![0].idempotencyKey;
    expect(key1).toBe(key2);
  });
});
