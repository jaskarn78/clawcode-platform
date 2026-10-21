/**
 * Minimal Slack Web API client over `fetch` — no SDK dependency.
 *
 * Why raw fetch: the box's npm install is unreliable and the `@slack/*`
 * packages are heavy. Every Slack Web API method is a JSON POST to
 * `https://slack.com/api/<method>` with a Bearer token, so a thin wrapper is
 * all we need for the v1 surface (post / update / react / auth).
 */
import type { Logger } from "pino";

const SLACK_API_BASE = "https://slack.com/api";

/**
 * Per-request timeout. CRITICAL: Node `fetch` has no default timeout, so
 * without this a slow/black-holed Slack at daemon boot (auth.test /
 * apps.connections.open) would hang `bridge.start()` and wedge the entire
 * daemon boot. With the timeout, a hang becomes a throw that the daemon's
 * fail-open catch handles (Slack disabled, daemon continues).
 */
const SLACK_FETCH_TIMEOUT_MS = 10_000;

/** Longer timeout for binary file downloads (images can be a few MB). */
const SLACK_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Shape every Slack Web API response shares. */
export type SlackApiResponse = {
  readonly ok: boolean;
  readonly error?: string;
  readonly [key: string]: unknown;
};

export class SlackApiError extends Error {
  constructor(
    public readonly method: string,
    public readonly slackError: string,
  ) {
    super(`Slack API ${method} failed: ${slackError}`);
    this.name = "SlackApiError";
  }
}

/** Slack errors that are safe to treat as success for idempotent ops. */
const BENIGN_ERRORS = new Set(["already_reacted", "no_reaction", "message_not_found"]);

/**
 * Low-level call. Honors one 429 retry (Retry-After). Throws SlackApiError on
 * `ok: false` unless the error is in `benignErrors`.
 */
export async function slackApiCall(
  method: string,
  token: string,
  body: Record<string, unknown>,
  log?: Logger,
  benignErrors: ReadonlySet<string> = BENIGN_ERRORS,
): Promise<SlackApiResponse> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      // Hang-guard — see SLACK_FETCH_TIMEOUT_MS. A timeout aborts the fetch and
      // throws, so a wedged Slack can never block daemon boot.
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after") ?? "1");
      const waitMs = Math.min(Math.max(retryAfter, 1), 30) * 1000;
      log?.warn({ method, waitMs }, "slack rate-limited; retrying once");
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }

    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) {
      const err = json.error ?? "unknown_error";
      if (benignErrors.has(err)) return json;
      throw new SlackApiError(method, err);
    }
    return json;
  }
  throw new SlackApiError(method, "rate_limited_after_retry");
}

/** Bot-token-scoped Web API client for the v1 method surface. */
export class SlackWebClient {
  constructor(
    private readonly botToken: string,
    private readonly log?: Logger,
  ) {}

  /** Resolve the bot's own user id (used to filter our own messages). */
  async authTestUserId(): Promise<string> {
    return (await this.authTest()).userId;
  }

  /**
   * auth.test plus the granted bot scopes (read from the `x-oauth-scopes`
   * response header — slackApiCall discards headers, so this does its own
   * fetch). Used at startup to decide whether per-message identity
   * (`chat:write.customize`) is available. Returns empty scopes if the header
   * is absent (then callers treat identity as optimistically allowed).
   */
  async authTest(): Promise<{ userId: string; scopes: string[] }> {
    const res = await fetch(`${SLACK_API_BASE}/auth.test`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: "{}",
      signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
    });
    const scopesHeader = res.headers.get("x-oauth-scopes") ?? "";
    const json = (await res.json()) as SlackApiResponse;
    if (!json.ok) throw new SlackApiError("auth.test", json.error ?? "unknown_error");
    const scopes = scopesHeader
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return { userId: String(json.user_id ?? ""), scopes };
  }

  /** Post a message with optional per-agent identity + thread reply. */
  async postMessage(args: {
    channel: string;
    text: string;
    username?: string;
    iconUrl?: string;
    iconEmoji?: string;
    threadTs?: string;
  }): Promise<{ ts: string; channel: string }> {
    const body: Record<string, unknown> = {
      channel: args.channel,
      text: args.text,
      // Disable Slack's automatic link unfurling for streamed agent output.
      unfurl_links: false,
      unfurl_media: false,
    };
    if (args.username) body.username = args.username;
    if (args.iconUrl) body.icon_url = args.iconUrl;
    else if (args.iconEmoji) body.icon_emoji = args.iconEmoji;
    if (args.threadTs) body.thread_ts = args.threadTs;

    const res = await slackApiCall("chat.postMessage", this.botToken, body, this.log);
    return { ts: String(res.ts ?? ""), channel: String(res.channel ?? args.channel) };
  }

  /** Replace the text of a posted message (progressive streaming). */
  async updateMessage(args: { channel: string; ts: string; text: string }): Promise<void> {
    await slackApiCall(
      "chat.update",
      this.botToken,
      { channel: args.channel, ts: args.ts, text: args.text },
      this.log,
    );
  }

  /** Add a reaction. `name` is a Slack emoji name without colons. */
  async addReaction(args: { channel: string; ts: string; name: string }): Promise<void> {
    await slackApiCall(
      "reactions.add",
      this.botToken,
      { channel: args.channel, timestamp: args.ts, name: args.name },
      this.log,
    );
  }

  /** Remove a reaction (benign if absent). */
  async removeReaction(args: { channel: string; ts: string; name: string }): Promise<void> {
    await slackApiCall(
      "reactions.remove",
      this.botToken,
      { channel: args.channel, timestamp: args.ts, name: args.name },
      this.log,
    );
  }

  /**
   * Download a Slack `url_private` file's bytes (requires `files:read`). Slack
   * file URLs are NOT public — they must be fetched with the bot token in the
   * Authorization header, so the agent's own Read/WebFetch can't reach them;
   * the daemon downloads here and hands the agent a local path instead.
   *
   * Returns the raw bytes. Throws on HTTP error, on a response that exceeds
   * `maxBytes`, or when the body is an HTML login page (the signal Slack
   * returns for an unauthorized/expired URL).
   */
  async downloadFile(urlPrivate: string, maxBytes: number): Promise<Uint8Array> {
    const res = await fetch(urlPrivate, {
      headers: { Authorization: `Bearer ${this.botToken}` },
      signal: AbortSignal.timeout(SLACK_DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);

    // A bot token without files:read (or an expired URL) gets an HTML login
    // page with status 200 — detect and reject rather than save garbage.
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("text/html")) {
      throw new Error("file download returned HTML (missing files:read scope or expired URL)");
    }

    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      throw new Error(`file too large: ${declared} > ${maxBytes} bytes`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`file too large: ${bytes.byteLength} > ${maxBytes} bytes`);
    }
    return bytes;
  }
}
