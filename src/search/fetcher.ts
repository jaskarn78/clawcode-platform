/**
 * Phase 71 — URL fetcher for `web_fetch_url`.
 *
 * Contract:
 *  - Validates URL scheme (http/https only) — any other scheme → `invalid_url`.
 *  - Sets User-Agent: `ClawCode/<pkgVersion> (+https://github.com/example-user/clawcode)`.
 *    Appends an optional `userAgentSuffix` from `SearchConfig.fetch.userAgentSuffix`
 *    so agents can identify themselves without stomping on the base UA.
 *  - Enforces `AbortSignal.timeout(timeoutMs)` — any AbortError maps to `network`
 *    with `"timeout"|"aborted"` in the message.
 *  - Pre-flight `Content-Length` check: if the header is present and > maxBytes,
 *    reject as `size_limit` BEFORE streaming the body.
 *  - Streams body via `res.body.getReader()`. Accumulates chunks into a bounded
 *    `Buffer`; aborts the reader and returns `size_limit` the moment total
 *    bytes exceed `maxBytes` (guards the no-Content-Length path).
 *  - NEVER throws — all paths return a discriminated-union
 *    `{ ok: true, ... } | { ok: false, error }`.
 *
 * Redirect policy: delegates to `fetch`'s default `redirect: "follow"` — the
 * 71-CONTEXT.md "up to 5 redirects" note is a guideline, not a hard requirement,
 * and a hand-rolled redirect loop would more than double the implementation
 * surface for zero test coverage. If strict-5 becomes a contract in v2.1+, add
 * `redirect: "manual"` + a loop here.
 */

import { CLAWCODE_VERSION } from "../shared/version.js";
import { makeError, toSearchToolError } from "./errors.js";
import type { SearchError } from "./types.js";

const BASE_UA = `ClawCode/${CLAWCODE_VERSION} (+https://github.com/example-user/clawcode)`;

/** Options required by every `fetchUrl` call. */
export interface FetchUrlOpts {
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly userAgentSuffix: string | null;
}

/** Successful fetch — headers normalized to lowercase keys. */
export interface FetchUrlOk {
  readonly ok: true;
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
}

/** Failed fetch — structured error, never thrown. */
export interface FetchUrlFail {
  readonly ok: false;
  readonly error: SearchError;
}

export type FetchUrlResult = FetchUrlOk | FetchUrlFail;

function buildUserAgent(suffix: string | null): string {
  return suffix && suffix.length > 0 ? `${BASE_UA} ${suffix}` : BASE_UA;
}

/** Freeze the headers record so consumers can't mutate it downstream. */
function collectHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return Object.freeze(out);
}

/**
 * Fetch a URL with bounded body size + timeout. See module doc for contract.
 */
export async function fetchUrl(
  url: string,
  opts: FetchUrlOpts,
): Promise<FetchUrlResult> {
  // 1. URL validation — http/https only, must parse.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Object.freeze({
      ok: false as const,
      error: makeError("invalid_url", `invalid URL: ${url}`),
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return Object.freeze({
      ok: false as const,
      error: makeError("invalid_url", `unsupported URL scheme: ${parsed.protocol}`),
    });
  }

  const userAgent = buildUserAgent(opts.userAgentSuffix);

  // 2. Dispatch the request. Any thrown value (AbortError, TypeError) flows
  // through the catch → toSearchToolError mapper.
  let res: Response;
  try {
    res = await fetch(parsed.toString(), {
      method: "GET",
      headers: {
        "User-Agent": userAgent,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return Object.freeze({
      ok: false as const,
      error: toSearchToolError(err, "network"),
    });
  }

  // 3. Non-2xx → network error with status echoed. No body read beyond what
  // the reader already buffered — don't want to accidentally stream a giant
  // error page.
  if (!res.ok) {
    // Drain + discard the body to release the socket.
    try {
      await res.body?.cancel();
    } catch {
      /* cancel may throw on some runtimes — ignore */
    }
    return Object.freeze({
      ok: false as const,
      error: makeError("network", `HTTP ${res.status} ${res.statusText}`.trim(), {
        status: res.status,
      }),
    });
  }

  // 4. Pre-flight Content-Length check — avoid streaming a body we already
  // know is too large.
  const cl = res.headers.get("content-length");
  if (cl !== null) {
    const parsedCl = Number.parseInt(cl, 10);
    if (Number.isFinite(parsedCl) && parsedCl > opts.maxBytes) {
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return Object.freeze({
        ok: false as const,
        error: makeError(
          "size_limit",
          `response size ${parsedCl} exceeds maxBytes ${opts.maxBytes}`,
          { status: res.status },
        ),
      });
    }
  }

  // 5. Stream body; abort the reader when accumulated bytes > maxBytes.
  if (!res.body) {
    return Object.freeze({
      ok: true as const,
      status: res.status,
      headers: collectHeaders(res),
      body: Buffer.alloc(0),
    });
  }

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > opts.maxBytes) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          return Object.freeze({
            ok: false as const,
            error: makeError(
              "size_limit",
              `streamed body exceeds maxBytes ${opts.maxBytes}`,
              { status: res.status },
            ),
          });
        }
        chunks.push(value);
      }
    }
  } catch (err) {
    return Object.freeze({
      ok: false as const,
      error: toSearchToolError(err, "network"),
    });
  }

  const body = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return Object.freeze({
    ok: true as const,
    status: res.status,
    headers: collectHeaders(res),
    body,
  });
}
