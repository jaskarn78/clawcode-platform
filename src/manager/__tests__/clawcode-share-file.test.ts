/**
 * Phase 94 Plan 05 + Phase 96 Plan 04 — clawcode_share_file tests.
 *
 * Phase 94 baseline (6 tests):
 *   SF-HAPPY          — happy share via webhook returns CDN URL + filename + sizeBytes
 *   SF-OVERSIZE       — 26MB file → ToolCallError(unknown) with suggestion mentioning 25MB
 *   SF-PATH-OUTSIDE   — /etc/passwd outside allowedRoots → ToolCallError(permission) "outside"
 *   SF-FILE-NOT-FOUND — stat ENOENT → ToolCallError with verbatim ENOENT message
 *   SF-FALLBACK       — webhook rejects, bot-direct succeeds → success with both calls in order
 *   SF-CAPTION        — input.caption flows through to the upload args verbatim
 *
 * Phase 96 D-09 + D-12 extension (8 NEW tests):
 *   SF-OUTPUT-RELATIVE              — relative path resolved via outputDirTemplate (D-09)
 *   SF-OUTPUT-ABSOLUTE-PASSTHROUGH  — absolute path skips outputDir resolution
 *   SF-CLASSIFY-SIZE                — oversize → errorClass='unknown' + 25MB suggestion
 *   SF-CLASSIFY-MISSING             — ENOENT → errorClass='unknown' + 'file not found'
 *   SF-CLASSIFY-PERMISSION          — outside roots → errorClass='permission' + fileAccess hint
 *   SF-CLASSIFY-TRANSIENT           — webhook + bot reject 429 → errorClass='transient' + retry hint
 *   SF-DIRECTIVE-IN-PROMPT          — DEFAULT_SYSTEM_PROMPT_DIRECTIVES contains BOTH D-10 substrings
 *   SF-NO-ENUM-DRIFT                — no errorClass='size' or 'missing' values used
 */

import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import {
  clawcodeShareFile,
  DISCORD_FILE_SIZE_LIMIT,
} from "../tools/clawcode-share-file.js";
import type { ToolCallError } from "../tool-call-error.js";
import { DEFAULT_SYSTEM_PROMPT_DIRECTIVES } from "../../config/schema.js";

const silentLog = pino({ level: "silent" });

const ALLOWED_ROOT = "/home/clawcode/agent/x";
const ALLOWED_PATH = "/home/clawcode/agent/x/out.png";

function makeDeps(
  overrides: Partial<{
    stat: (path: string) => Promise<{ size: number; isFile: boolean }>;
    sendViaWebhook: (
      channelId: string,
      file: { path: string; filename: string; caption?: string },
    ) => Promise<{ url: string }>;
    sendViaBot: (
      channelId: string,
      file: { path: string; filename: string; caption?: string },
    ) => Promise<{ url: string }>;
    currentChannelId: () => string | undefined;
    allowedRoots: readonly string[];
    outputDirTemplate: string | undefined;
    agentWorkspaceRoot: string | undefined;
    resolveCtx: () => {
      agent: string;
      channelName?: string;
      clientSlug?: string;
      now?: Date;
    };
  }> = {},
) {
  return {
    allowedRoots: overrides.allowedRoots ?? [ALLOWED_ROOT],
    stat:
      overrides.stat ??
      vi.fn(async (_path: string) => ({ size: 1024, isFile: true })),
    sendViaWebhook:
      overrides.sendViaWebhook ??
      vi.fn(async (_chan: string, _file) => ({
        url: "https://cdn.discord/x",
      })),
    sendViaBot:
      overrides.sendViaBot ??
      vi.fn(async (_chan: string, _file) => ({
        url: "https://cdn.discord/bot-direct",
      })),
    currentChannelId: overrides.currentChannelId ?? vi.fn(() => "channel-123"),
    log: silentLog,
    ...(overrides.outputDirTemplate !== undefined
      ? { outputDirTemplate: overrides.outputDirTemplate }
      : {}),
    ...(overrides.agentWorkspaceRoot !== undefined
      ? { agentWorkspaceRoot: overrides.agentWorkspaceRoot }
      : {}),
    ...(overrides.resolveCtx !== undefined
      ? { resolveCtx: overrides.resolveCtx }
      : {}),
  };
}

describe("clawcodeShareFile — Phase 94 TOOL-09 baseline", () => {
  it("SF-HAPPY: stat 1KB + webhook resolves → output.url is the CDN URL", async () => {
    const deps = makeDeps();
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    if ("kind" in result) {
      throw new Error(`expected success, got error: ${result.message}`);
    }
    expect(result.url).toBe("https://cdn.discord/x");
    expect(result.filename).toBe("out.png");
    expect(result.sizeBytes).toBe(1024);
    expect(deps.sendViaWebhook).toHaveBeenCalledTimes(1);
    expect(deps.sendViaBot).not.toHaveBeenCalled();
  });

  it("SF-OVERSIZE: 26MB file → ToolCallError(unknown) with suggestion mentioning 25MB", async () => {
    const oversize = 26 * 1024 * 1024;
    const deps = makeDeps({
      stat: vi.fn(async () => ({ size: oversize, isFile: true })),
    });
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.kind).toBe("ToolCallError");
    expect(err.errorClass).toBe("unknown");
    const suggestion = err.suggestion ?? "";
    const messageOrSuggestion = `${suggestion} ${err.message}`;
    expect(/25\s*MB/i.test(messageOrSuggestion)).toBe(true);
    expect(deps.sendViaWebhook).not.toHaveBeenCalled();
    expect(deps.sendViaBot).not.toHaveBeenCalled();
    expect(oversize).toBeGreaterThan(DISCORD_FILE_SIZE_LIMIT);
  });

  it("SF-PATH-OUTSIDE: /etc/passwd outside allowedRoots → ToolCallError(permission) mentions 'outside'", async () => {
    const deps = makeDeps({
      allowedRoots: [ALLOWED_ROOT],
      stat: vi.fn(async () => ({ size: 100, isFile: true })),
    });
    const result = await clawcodeShareFile({ path: "/etc/passwd" }, deps);

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.kind).toBe("ToolCallError");
    expect(err.errorClass).toBe("permission");
    expect(/outside|permission/i.test(err.message)).toBe(true);
    expect(deps.stat).not.toHaveBeenCalled();
    expect(deps.sendViaWebhook).not.toHaveBeenCalled();
    expect(deps.sendViaBot).not.toHaveBeenCalled();
  });

  it("SF-FILE-NOT-FOUND: stat rejects with ENOENT → ToolCallError with verbatim message", async () => {
    const enoent = new Error(
      "ENOENT: no such file or directory, stat '/home/clawcode/agent/x/missing.png'",
    );
    const deps = makeDeps({
      stat: vi.fn(async () => {
        throw enoent;
      }),
    });
    const result = await clawcodeShareFile(
      { path: "/home/clawcode/agent/x/missing.png" },
      deps,
    );

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.kind).toBe("ToolCallError");
    expect(err.message).toBe(enoent.message); // verbatim pass-through
  });

  it("SF-FALLBACK: webhook rejects once → bot-direct resolves → success; both called in order", async () => {
    const callOrder: string[] = [];
    const sendViaWebhook = vi.fn(async () => {
      callOrder.push("webhook");
      throw new Error("webhook 500 cloudflare");
    });
    const sendViaBot = vi.fn(async () => {
      callOrder.push("bot");
      return { url: "https://cdn.discord/via-bot" };
    });
    const deps = makeDeps({ sendViaWebhook, sendViaBot });

    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    if ("kind" in result) {
      throw new Error(`expected fallback success, got error: ${result.message}`);
    }
    expect(result.url).toBe("https://cdn.discord/via-bot");
    expect(callOrder).toEqual(["webhook", "bot"]);
  });

  it("SF-CAPTION: input.caption flows through verbatim to the upload args", async () => {
    const sendViaWebhook = vi.fn(
      async (
        _chan: string,
        _file: { path: string; filename: string; caption?: string },
      ) => ({ url: "https://cdn.discord/x" }),
    );
    const deps = makeDeps({ sendViaWebhook });

    await clawcodeShareFile(
      { path: ALLOWED_PATH, caption: "my output" },
      deps,
    );

    expect(sendViaWebhook).toHaveBeenCalledTimes(1);
    const args = sendViaWebhook.mock.calls[0]!;
    expect(args[1].caption).toBe("my output");
  });
});

describe("clawcodeShareFile — Phase 96 D-09 outputDir + D-12 classification", () => {
  it("SF-OUTPUT-RELATIVE: relative path resolved via outputDirTemplate → uploaded under resolved dir", async () => {
    // outputDirTemplate present; relative input path → outputDir prepended.
    const deps = makeDeps({
      outputDirTemplate: "clients/{client_slug}/{date}/",
      agentWorkspaceRoot: ALLOWED_ROOT,
      resolveCtx: () => ({
        agent: "fin-client",
        clientSlug: "tara-maffeo",
        channelName: "acme-client-acquisition",
        now: new Date("2026-04-25T16:00:00Z"),
      }),
    });
    const result = await clawcodeShareFile({ path: "output.pdf" }, deps);

    if ("kind" in result) {
      throw new Error(`expected success, got error: ${result.message}`);
    }
    // Webhook called with the resolved absolute path under outputDir
    expect(deps.sendViaWebhook).toHaveBeenCalledTimes(1);
    const args = (deps.sendViaWebhook as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const uploadedPath = args[1].path as string;
    expect(uploadedPath).toContain("clients/tara-maffeo/2026-04-25");
    expect(uploadedPath).toContain("output.pdf");
    expect(uploadedPath.startsWith(ALLOWED_ROOT)).toBe(true);
  });

  it("SF-OUTPUT-ABSOLUTE-PASSTHROUGH: absolute path skips outputDir resolution", async () => {
    const deps = makeDeps({
      outputDirTemplate: "clients/{client_slug}/{date}/",
      agentWorkspaceRoot: ALLOWED_ROOT,
      resolveCtx: () => ({
        agent: "fin-client",
        clientSlug: "tara-maffeo",
        channelName: "ch",
        now: new Date("2026-04-25T16:00:00Z"),
      }),
      // The absolute path must be in allowedRoots
      allowedRoots: [ALLOWED_ROOT],
    });
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    if ("kind" in result) {
      throw new Error(`expected success, got error: ${result.message}`);
    }
    expect(deps.sendViaWebhook).toHaveBeenCalledTimes(1);
    const args = (deps.sendViaWebhook as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // The absolute path passed through unchanged — no outputDir prepended
    expect(args[1].path).toBe(ALLOWED_PATH);
    // Should NOT contain client/date markers from the outputDir template
    expect(args[1].path).not.toContain("tara-maffeo");
    expect(args[1].path).not.toContain("2026-04-25");
  });

  it("SF-CLASSIFY-SIZE: 30MB file → errorClass='unknown' + suggestion contains 25MB + Discord limit", async () => {
    const oversize = 30 * 1024 * 1024;
    const deps = makeDeps({
      stat: vi.fn(async () => ({ size: oversize, isFile: true })),
    });
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.errorClass).toBe("unknown");
    expect(err.errorClass).not.toBe("size"); // NO enum drift
    const fullText = `${err.message} ${err.suggestion ?? ""}`;
    expect(/25\s*MB|Discord limit/i.test(fullText)).toBe(true);
  });

  it("SF-CLASSIFY-MISSING: ENOENT → errorClass='unknown' + suggestion contains 'file not found'", async () => {
    const enoent = new Error(
      "ENOENT: no such file or directory, stat '/home/clawcode/agent/x/ghost.pdf'",
    );
    const deps = makeDeps({
      stat: vi.fn(async () => {
        throw enoent;
      }),
    });
    const result = await clawcodeShareFile(
      { path: "/home/clawcode/agent/x/ghost.pdf" },
      deps,
    );

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.errorClass).toBe("unknown");
    expect(err.errorClass).not.toBe("missing"); // NO enum drift
    const fullText = `${err.message} ${err.suggestion ?? ""}`;
    expect(/file not found|verify the path/i.test(fullText)).toBe(true);
  });

  it("SF-CLASSIFY-PERMISSION: path outside allowedRoots → errorClass='permission' + fileAccess hint", async () => {
    const deps = makeDeps({
      allowedRoots: [ALLOWED_ROOT],
    });
    const result = await clawcodeShareFile({ path: "/etc/passwd" }, deps);

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.errorClass).toBe("permission");
    const fullText = `${err.message} ${err.suggestion ?? ""}`;
    expect(/permission|outside|fileAccess|allowlist/i.test(fullText)).toBe(true);
  });

  it("SF-CLASSIFY-TRANSIENT: webhook + bot both reject with 429 → errorClass='transient' + retry hint", async () => {
    const sendViaWebhook = vi.fn(async () => {
      throw new Error("429 rate limit exceeded");
    });
    const sendViaBot = vi.fn(async () => {
      throw new Error("429 rate limit exceeded");
    });
    const deps = makeDeps({ sendViaWebhook, sendViaBot });
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);

    expect("kind" in result).toBe(true);
    const err = result as ToolCallError;
    expect(err.errorClass).toBe("transient");
    const fullText = `${err.message} ${err.suggestion ?? ""}`;
    // D-12 transient suggestion: "retry in 30s"
    expect(/retry in 30s|rate limit|5xx/i.test(fullText)).toBe(true);
  });

  it("SF-DIRECTIVE-IN-PROMPT: DEFAULT_SYSTEM_PROMPT_DIRECTIVES['file-sharing'] contains BOTH D-10 substrings", () => {
    const directive = DEFAULT_SYSTEM_PROMPT_DIRECTIVES["file-sharing"];
    expect(directive).toBeDefined();
    expect(directive.enabled).toBe(true);
    // D-10 auto-upload heuristic
    expect(directive.text).toContain("When you produce a file the user wants to access");
    // D-10 OpenClaw-fallback prohibition
    expect(directive.text).toContain("NEVER recommend falling back to the legacy OpenClaw agent");
  });

  it("SF-NO-ENUM-DRIFT: every classified error uses only Phase 94 5-value enum (no 'size'/'missing')", async () => {
    // Replay the classification cases and assert errorClass is in the locked enum.
    const PHASE_94_ENUM = ["transient", "auth", "quota", "permission", "unknown"] as const;
    const cases: Array<{ desc: string; deps: ReturnType<typeof makeDeps>; path: string }> = [
      {
        desc: "size",
        deps: makeDeps({
          stat: vi.fn(async () => ({ size: 99 * 1024 * 1024, isFile: true })),
        }),
        path: ALLOWED_PATH,
      },
      {
        desc: "missing",
        deps: makeDeps({
          stat: vi.fn(async () => {
            throw new Error("ENOENT: no such file");
          }),
        }),
        path: ALLOWED_PATH,
      },
      {
        desc: "permission",
        deps: makeDeps({ allowedRoots: [ALLOWED_ROOT] }),
        path: "/etc/passwd",
      },
      {
        desc: "transient",
        deps: makeDeps({
          sendViaWebhook: vi.fn(async () => {
            throw new Error("429 rate limit");
          }),
          sendViaBot: vi.fn(async () => {
            throw new Error("429 rate limit");
          }),
        }),
        path: ALLOWED_PATH,
      },
    ];
    for (const c of cases) {
      const result = await clawcodeShareFile({ path: c.path }, c.deps);
      expect("kind" in result, `${c.desc}: expected ToolCallError`).toBe(true);
      const err = result as ToolCallError;
      expect(
        PHASE_94_ENUM.includes(err.errorClass as (typeof PHASE_94_ENUM)[number]),
        `${c.desc}: errorClass=${err.errorClass} not in Phase 94 5-value enum`,
      ).toBe(true);
    }
  });
});

// UX-A (2026-08-26) — messageId/channelId pass-through for superseded-share
// marking. Additive-optional: legacy {url}-only surfaces stay valid (every
// other test in this file pins that), and surfaces that DO report the
// posted message land it on ShareFileOutput.
describe("clawcodeShareFile — share message ref pass-through (UX-A)", () => {
  it("carries messageId/channelId from the webhook surface when reported", async () => {
    const sendViaWebhook: (
      channelId: string,
      file: { path: string; filename: string; caption?: string },
    ) => Promise<{ url: string; messageId?: string; channelId?: string }> =
      async () => ({ url: "https://cdn/x.png", messageId: "msg-9", channelId: "chan-7" });
    const deps = { ...makeDeps(), sendViaWebhook };
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);
    expect("kind" in result).toBe(false);
    const out = result as { url: string; messageId?: string; channelId?: string };
    expect(out.messageId).toBe("msg-9");
    expect(out.channelId).toBe("chan-7");
  });

  it("carries the ref from the bot-direct fallback too", async () => {
    const sendViaWebhook = async () => {
      throw new Error("webhook down");
    };
    const sendViaBot: (
      channelId: string,
      file: { path: string; filename: string; caption?: string },
    ) => Promise<{ url: string; messageId?: string; channelId?: string }> =
      async () => ({ url: "https://cdn/y.png", messageId: "msg-10", channelId: "chan-7" });
    const deps = { ...makeDeps(), sendViaWebhook, sendViaBot };
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, deps);
    expect("kind" in result).toBe(false);
    const out = result as { messageId?: string; channelId?: string };
    expect(out.messageId).toBe("msg-10");
  });

  it("omits the fields when the surface reports only {url} (legacy shape)", async () => {
    const result = await clawcodeShareFile({ path: ALLOWED_PATH }, makeDeps());
    expect("kind" in result).toBe(false);
    expect((result as { messageId?: string }).messageId).toBeUndefined();
  });
});
