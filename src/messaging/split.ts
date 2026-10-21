/**
 * Message splitting — respect a platform's per-message character ceiling.
 *
 * Behavior matches the Discord `splitMessage` helper (src/discord/bridge.ts):
 * prefer a newline boundary, then a space, then a hard cut. Shared here so
 * every adapter chunks identically.
 */
export function splitMessage(text: string, maxLength: number): readonly string[] {
  if (maxLength <= 0) return [text];
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength / 2) {
      splitIndex = maxLength;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks.length > 0 ? chunks : [""];
}
