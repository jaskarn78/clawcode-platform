/**
 * 999.95-fu (2026-09-02) — instant inline preview snapshots.
 *
 * Operator feedback: "I don't want to have to launch an activity to view.
 * It's too slow." The Activity stays as the interactive upgrade; the DEFAULT
 * view becomes a PNG snapshot of the page posted straight into the channel —
 * Discord renders image attachments instantly, phone included, zero launches.
 *
 * Rendering is a bounded one-shot spawn of the Playwright-cache headless
 * Chromium already present on the box (installed by the patchright MCP setup):
 *
 *   headless_shell --headless --no-sandbox --disable-gpu --hide-scrollbars
 *     --force-device-scale-factor=2 --window-size=390,1400
 *     --screenshot=<png> <file|url>
 *
 * Validated live on prod before this module was written: the staged demo page
 * rendered 780x2800 @2x in ~2s, 436 KB. Caps: 25s timeout, 8 MB output
 * (Discord's attachment ceiling for bots on default servers), viewport pinned
 * to an iPhone-ish 390pt width so snapshots read naturally on the operator's
 * phone.
 *
 * FAIL-SOFT EVERYWHERE: no binary, render timeout, oversized output — all
 * return null and the preview push proceeds exactly as before (launch button
 * only). A screenshot must never break show_preview.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

/**
 * 999.95-fu2 — MOTION snapshots. Beyond the static PNG: record ~9s of the
 * LIVE page (CSS animations + page JS actually running) via the patchright
 * browser, transcode to a small h264 mp4, and post it — Discord auto-plays
 * inline video, so the channel gets a self-playing tour of the preview with
 * zero taps. Proven on prod before this code was written: 9s of the animated
 * shopping demo → 560KB webm → 198KB mp4.
 *
 * The recorder script lives INSIDE the patchright package dir so its bare
 * `patchright` import resolves (ESM ignores NODE_PATH — the exact failure the
 * first attempt hit). Same fail-soft contract as the PNG path.
 */

const execFileP = promisify(execFile);

const RENDER_TIMEOUT_MS = 25_000;
const MOTION_TIMEOUT_MS = 75_000;
const MOTION_MS = Number(process.env.CLAWCODE_PREVIEW_MOTION_MS ?? 9000);
const RECORDER_DIR =
  process.env.CLAWCODE_PREVIEW_RECORDER_DIR ??
  "/opt/clawcode-mcp-servers/node/patchright-mcp-lite";
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_PNG_BYTES = 8 * 1024 * 1024;
const VIEWPORT = "390,1400";
const SCALE = "2";

/**
 * Locate a headless Chromium in the Playwright browser cache. Newest revision
 * wins; `headless_shell` builds are preferred over full `chrome` (smaller,
 * purpose-built for exactly this). Overridable via CLAWCODE_HEADLESS_SHELL.
 * Resolution is cached for the daemon lifetime (the cache dir only changes
 * when someone installs browsers, which implies a redeploy anyway).
 */
let cachedBinary: string | null | undefined;
export async function resolveHeadlessBinary(log?: Logger): Promise<string | null> {
  if (cachedBinary !== undefined) return cachedBinary;
  const override = process.env.CLAWCODE_HEADLESS_SHELL?.trim();
  if (override) {
    cachedBinary = override;
    return cachedBinary;
  }
  try {
    const root = join(homedir(), ".cache", "ms-playwright");
    const entries = await readdir(root);
    const pick = (prefix: string, sub: string, bin: string): string[] =>
      entries
        .filter((e) => e.startsWith(prefix))
        .sort()
        .reverse()
        .map((e) => join(root, e, sub, bin));
    const candidates = [
      ...pick("chromium_headless_shell-", "chrome-linux", "headless_shell"),
      ...pick("chromium-", "chrome-linux64", "chrome"),
      ...pick("chromium-", "chrome-linux", "chrome"),
    ];
    for (const c of candidates) {
      try {
        await stat(c);
        cachedBinary = c;
        return cachedBinary;
      } catch {
        /* next candidate */
      }
    }
  } catch (err) {
    log?.debug?.({ err: String(err) }, "preview-snapshot: no playwright cache");
  }
  cachedBinary = null;
  return cachedBinary;
}

/** Test seam: forget the cached binary resolution. */
export function _resetBinaryCache(): void {
  cachedBinary = undefined;
}

export type SnapshotInput =
  | { readonly kind: "html"; readonly html: string }
  | { readonly kind: "url"; readonly url: string };

/**
 * Render a preview to a PNG buffer, or null when rendering is unavailable or
 * fails (fail-soft contract — callers proceed without a snapshot).
 */
export async function renderPreviewSnapshot(
  input: SnapshotInput,
  log: Logger,
  deps: { readonly exec?: typeof execFileP; readonly binary?: string | null } = {},
): Promise<Buffer | null> {
  const exec = deps.exec ?? execFileP;
  const binary = deps.binary !== undefined ? deps.binary : await resolveHeadlessBinary(log);
  if (!binary) {
    log.info("preview-snapshot: no headless chromium available — skipping snapshot");
    return null;
  }

  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "preview-snap-"));
    const pngPath = join(workDir, "snap.png");
    // Preferred: full-page shot via patchright, which captures the CONTENT
    // height. The headless_shell fallback below captures the fixed viewport and
    // pads short pages with dead space (999.95-fu3 operator report).
    const shotScript = join(RECORDER_DIR, "shot.mjs");
    if (!deps.exec) {
      try {
        await stat(shotScript);
        let target: string;
        if (input.kind === "html") {
          const htmlPath = join(workDir, "page.html");
          await writeFile(htmlPath, input.html, "utf8");
          target = htmlPath;
        } else {
          target = input.url;
        }
        await exec("node", [shotScript, target, pngPath, "390"], {
          timeout: RENDER_TIMEOUT_MS,
          cwd: RECORDER_DIR,
        });
        const full = await readFile(pngPath);
        if (full.length > 0 && full.length <= MAX_PNG_BYTES) return full;
      } catch (err) {
        log.info(
          { error: String(err).slice(0, 160) },
          "preview-snapshot: full-page shot unavailable — using viewport fallback",
        );
      }
    }
    let target: string;
    if (input.kind === "html") {
      const htmlPath = join(workDir, "page.html");
      await writeFile(htmlPath, input.html, "utf8");
      target = `file://${htmlPath}`;
    } else {
      target = input.url;
    }
    await exec(
      binary,
      [
        "--headless",
        "--no-sandbox",
        "--disable-gpu",
        "--hide-scrollbars",
        `--force-device-scale-factor=${SCALE}`,
        `--window-size=${VIEWPORT}`,
        `--screenshot=${pngPath}`,
        // Never let a page keep the renderer alive with long timers.
        "--virtual-time-budget=8000",
        target,
      ],
      { timeout: RENDER_TIMEOUT_MS },
    );
    const png = await readFile(pngPath);
    if (png.length === 0 || png.length > MAX_PNG_BYTES) {
      log.warn(
        { bytes: png.length },
        "preview-snapshot: render produced empty/oversized png — skipping",
      );
      return null;
    }
    return png;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg.slice(0, 300) }, "preview-snapshot: render failed — skipping");
    return null;
  } finally {
    if (workDir) {
      rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}


export type MotionResult = { readonly buffer: Buffer; readonly filename: string };

/**
 * Record a motion snapshot (mp4) of the preview, or null (fail-soft).
 * Set CLAWCODE_PREVIEW_MOTION=off to disable motion fleet-wide (PNG fallback
 * still applies); CLAWCODE_PREVIEW_MOTION_MS tunes the recording length.
 */
export async function renderPreviewMotion(
  input: SnapshotInput,
  log: Logger,
  deps: { readonly exec?: typeof execFileP; readonly recorderDir?: string } = {},
): Promise<MotionResult | null> {
  // 2026-09-02 operator decision: "ditch the video and just present a clean
  // image." Motion is now OPT-IN (CLAWCODE_PREVIEW_MOTION=on); the default
  // tier is the full-page PNG, which frames tightly and reads instantly on a
  // phone with no tap-to-play.
  //
  // NOTE for anyone re-enabling motion: record.mjs passes recordVideo.size =
  // 2x the viewport. Playwright only scales a page DOWN into the video frame,
  // never up — so the page lands in the top-left of a double-sized canvas and
  // the rest is gray padding. That is the letterboxing the operator saw. Fix
  // the size to match the viewport before turning this back on.
  if ((process.env.CLAWCODE_PREVIEW_MOTION ?? "").toLowerCase() !== "on") return null;
  const exec = deps.exec ?? execFileP;
  const dir = deps.recorderDir ?? RECORDER_DIR;
  const script = join(dir, "record.mjs");
  try {
    await stat(script);
  } catch {
    log.info({ script }, "preview-motion: recorder script missing — skipping motion");
    return null;
  }
  let workDir: string | null = null;
  try {
    workDir = await mkdtemp(join(tmpdir(), "preview-motion-"));
    let target: string;
    if (input.kind === "html") {
      const htmlPath = join(workDir, "page.html");
      await writeFile(htmlPath, input.html, "utf8");
      target = htmlPath; // record.mjs prefixes file:// for non-http targets
    } else {
      target = input.url;
    }
    const webm = join(workDir, "clip.webm");
    const mp4 = join(workDir, "clip.mp4");
    await exec("node", [script, target, webm, String(MOTION_MS)], {
      timeout: MOTION_TIMEOUT_MS,
      cwd: dir,
    });
    await exec(
      "ffmpeg",
      ["-v", "error", "-y", "-i", webm, "-c:v", "libx264", "-pix_fmt", "yuv420p",
       "-movflags", "+faststart", "-crf", "26", "-an", mp4],
      { timeout: 60_000 },
    );
    const buf = await readFile(mp4);
    if (buf.length === 0 || buf.length > MAX_VIDEO_BYTES) {
      log.warn({ bytes: buf.length }, "preview-motion: empty/oversized mp4 — skipping");
      return null;
    }
    return { buffer: buf, filename: "preview.mp4" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ error: msg.slice(0, 300) }, "preview-motion: failed — falling back to PNG");
    return null;
  } finally {
    if (workDir) rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
