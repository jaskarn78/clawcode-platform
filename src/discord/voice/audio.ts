/**
 * Phase 135 Plan 02 — Opus → PCM transcoder.
 *
 * Pipes a Discord voice receiver Opus stream through `prism-media`'s
 * OpusDecoder configured for 48kHz stereo (Discord's native voice format).
 * Output is Linear16 PCM consumable by Deepgram's streaming WS endpoint
 * (RESEARCH § Code Examples > Audio).
 *
 * Pitfall 1 in 135-RESEARCH: prism-media's decoder silently emits
 * zero-byte PCM if no native Opus codec is loaded. The `@discordjs/opus`
 * direct-dependency (installed by Plan 01 Task 1) is what makes the
 * decoder actually work. Plan 02 RELIES on that direct dep being
 * present — no fallback to the optional alternative codecs.
 */
import { Readable } from "node:stream";
// Plan 02 — the prism-media import requires the native Opus codec to be
// loadable. With `@discordjs/opus` as a direct dependency (Plan 01
// Task 1) this resolves cleanly at process start.
//
// prism-media exposes itself as both a CJS and ESM bundle; we use the
// default-export CJS shape since the package.json types resolution under
// our build target points at the CJS d.ts.
import prism from "prism-media";

/**
 * Decode a Discord Opus packet stream into a 48kHz stereo Linear16 PCM
 * stream consumable by Deepgram's WS ingest endpoint.
 *
 * The pipeline shape mirrors RESEARCH § Code Examples > Audio:
 *   opusStream
 *     .pipe(new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 }))
 *
 * @param opusStream  Discord voice receiver Opus stream (Manual end behavior).
 * @returns           Linear16 stereo PCM Readable.
 */
export function decodeOpusToLinear16(opusStream: Readable): Readable {
  const decoder = new prism.opus.Decoder({
    rate: 48000,
    channels: 2,
    frameSize: 960,
  });
  return opusStream.pipe(decoder);
}
