import { join } from "node:path";
import { format } from "date-fns";
import { nanoid } from "nanoid";

/**
 * Phase 70 — screenshot path + MCP content envelope helpers.
 *
 * Plan 02 consumer: `mcp-server.ts buildMcpResponse()` calls
 * `encodeScreenshot` when a tool returns `inlineBase64` data. `tools.ts`
 * calls `resolveScreenshotSavePath` to derive the default disk path when
 * the agent does not provide `savePath`.
 *
 * Design notes:
 *   - `encodeScreenshot` enforces the 70-RESEARCH.md Pitfall 7 guard:
 *     only inline base64 when the buffer fits under `maxInlineBytes`.
 *     `maxInlineBytes === 0` is a valid sentinel meaning "never inline".
 *   - `resolveScreenshotSavePath` composes a collision-safe filename
 *     (`<epochMs>-<nanoid(6)>.png`) under a dated subdirectory so long
 *     sessions do not accumulate one giant directory of screenshots.
 *   - Both results are `Object.freeze`d per CLAUDE.md immutability.
 */

/** MCP-SDK-compatible content item shape (subset we emit for screenshots). */
export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "image";
      readonly data: string;
      readonly mimeType: string;
    };

export interface ScreenshotEnvelope {
  readonly content: readonly McpContent[];
}

/**
 * Build the MCP content envelope for a captured screenshot.
 *
 * Envelope variants:
 *   - Inline (bytes ≤ maxInlineBytes AND maxInlineBytes > 0):
 *     two items — a text item carrying the JSON meta, then an image
 *     item carrying the base64 PNG. Claude's vision ingests the image
 *     automatically on this turn.
 *   - Path-only (too large OR maxInlineBytes === 0):
 *     one text item carrying the JSON meta with `inline: false` and a
 *     note steering the agent toward the `Read` tool for the path.
 *     This keeps conversation history small (Pitfall 7 guard).
 */
export function encodeScreenshot(
  buffer: Buffer,
  maxInlineBytes: number,
  meta: { path: string },
): ScreenshotEnvelope {
  const bytes = buffer.length;
  const shouldInline = maxInlineBytes > 0 && bytes <= maxInlineBytes;

  if (shouldInline) {
    return Object.freeze({
      content: Object.freeze([
        Object.freeze({
          type: "text" as const,
          text: JSON.stringify({
            path: meta.path,
            bytes,
            inline: true,
          }),
        }),
        Object.freeze({
          type: "image" as const,
          data: buffer.toString("base64"),
          mimeType: "image/png",
        }),
      ]),
    });
  }

  return Object.freeze({
    content: Object.freeze([
      Object.freeze({
        type: "text" as const,
        text: JSON.stringify({
          path: meta.path,
          bytes,
          inline: false,
          note: "Screenshot too large to inline; use Read tool on the path.",
        }),
      }),
    ]),
  });
}

/**
 * Resolve the disk path for a screenshot.
 *
 * When the caller supplies `overridePath`, return it verbatim — the tool
 * layer is trusted to have validated the path (or, more commonly, to have
 * forwarded an agent-provided path for auditability).
 *
 * Otherwise, compose a collision-safe path under
 * `<workspace>/browser/screenshots/<yyyy-MM-dd>/<epochMs>-<nanoid(6)>.png`.
 * `nanoid(6)` is sufficient for per-millisecond uniqueness across the
 * handful of screenshots an agent takes per turn; the date prefix keeps
 * long-running agents' directories tidy.
 */
export function resolveScreenshotSavePath(
  workspace: string,
  overridePath?: string,
): string {
  if (overridePath && overridePath.length > 0) return overridePath;
  const date = format(new Date(), "yyyy-MM-dd");
  const id = `${Date.now()}-${nanoid(6)}`;
  return join(workspace, "browser", "screenshots", date, `${id}.png`);
}
