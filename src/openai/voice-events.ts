/**
 * Voice SSE status/tool event classifier (spec §4).
 *
 * Maps the driver's `SdkStreamEvent` stream into named SSE liveness frames the
 * voice client renders ("Searching the web…") and that double as liveness:
 *
 *   event: status  data: {"state":"thinking"|"generating"|"tool"}
 *   event: tool    data: {"phase":"start","name":<id>,"label":<phrase>}
 *   event: tool    data: {"phase":"end","name":<id>,"ok":true}
 *
 * Phase machine: thinking → generating → tool → generating. Tool-END is INFERRED
 * when text generation resumes after a tool — this stream view (the OpenAI
 * driver's event feed) carries no explicit `tool_result` boundary. Labels never
 * include raw tool args (info-disclosure). Emitted ONLY for voice-opted agents
 * (the server gates on `openaiVoice.enabled`); a non-voice turn never sees these.
 *
 * Pure + stateful per-turn — construct one classifier per stream.
 */
import type { SdkStreamEvent } from "./types.js";

export interface VoiceSseEvent {
  readonly event: "status" | "tool";
  readonly data: Record<string, unknown>;
}

/**
 * User-facing, present-tense labels per tool name. A short generic fallback
 * keeps unknown/custom MCP tools from leaking their machine name to TTS.
 */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  WebSearch: "Searching the web…",
  web_search: "Searching the web…",
  WebFetch: "Reading a page…",
  Read: "Reading a file…",
  Bash: "Running that…",
  Glob: "Looking through files…",
  Grep: "Searching the files…",
  memory_lookup: "Checking memory…",
  clawcode_share_file: "Preparing a file…",
};

export function labelForTool(name: string): string {
  return TOOL_LABELS[name] ?? "Working on it…";
}

/**
 * Strip the `mcp__<server>__` namespace prefix from a tool id so the internal
 * MCP server name (e.g. `acme-db`, `smarthome`) isn't leaked to the
 * external voice caller — keep only the local tool name. Non-MCP/built-in tool
 * names (`Bash`, `WebSearch`) are returned unchanged.
 */
export function sanitizeToolName(name: string): string {
  if (!name.startsWith("mcp__")) return name;
  const rest = name.slice("mcp__".length);
  const sep = rest.indexOf("__");
  return sep >= 0 ? rest.slice(sep + 2) : rest;
}

export interface VoiceEventClassifier {
  /** The status frame to emit immediately at stream start. */
  readonly initial: VoiceSseEvent;
  /** Map one driver event → 0..N voice SSE events (in emit order). */
  onEvent(event: SdkStreamEvent): VoiceSseEvent[];
}

export function createVoiceEventClassifier(): VoiceEventClassifier {
  let phase: "thinking" | "generating" | "tool" = "thinking";
  let activeTool: string | null = null;

  // Tool START → sanitized `event: tool` + `status: tool` (mutates phase state).
  const toolStartEvents = (rawName: string): VoiceSseEvent[] => {
    const safeName = sanitizeToolName(rawName);
    activeTool = safeName;
    phase = "tool";
    // Label from the RAW name (the label map keys built-in tools by their bare
    // name; namespaced MCP tools fall through to the generic label).
    return [
      { event: "tool", data: { phase: "start", name: safeName, label: labelForTool(rawName) } },
      { event: "status", data: { state: "tool" } },
    ];
  };

  return {
    initial: { event: "status", data: { state: "thinking" } },

    onEvent(event: SdkStreamEvent): VoiceSseEvent[] {
      // Driver-injected tool start (client tool_use OR server-side
      // server_tool_use like web_search) — the OpenAI driver's onChunk bridge
      // only surfaces text, so server-side tools reach the classifier ONLY via
      // this synthetic event.
      if (event.type === "voice_tool") {
        return toolStartEvents(event.name);
      }
      if (event.type !== "stream_event") return [];
      const inner = event.event;
      if (inner.type !== "content_block_start") return [];

      const out: VoiceSseEvent[] = [];
      const block = inner.content_block;

      if (block.type === "tool_use") {
        return toolStartEvents(block.name);
      }

      if (block.type === "text") {
        // Text resuming after a tool → infer that tool's completion.
        if (activeTool !== null) {
          out.push({
            event: "tool",
            data: { phase: "end", name: activeTool, ok: true },
          });
          activeTool = null;
        }
        if (phase !== "generating") {
          phase = "generating";
          out.push({ event: "status", data: { state: "generating" } });
        }
      }
      return out;
    },
  };
}
