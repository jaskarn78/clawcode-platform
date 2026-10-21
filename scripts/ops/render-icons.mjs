// 999.160 v1.2 — Render Lucide SVGs to 128px PNGs for Discord application emojis. Dev-time only; PNGs are committed.
// Usage: node scripts/ops/render-icons.mjs assets/icons   (dev-time; the PNGs are committed and shipped in dist/assets/icons)
import { writeFileSync, mkdirSync } from "node:fs";
import sharp from "sharp";
const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const STROKE = "#dbdee1"; // Discord dark-theme text
const SET = {
  check: "check", x: "x", warning: "triangle-alert", search: "search", brain: "brain", refresh: "refresh-cw",
  thumbs_up: "thumbs-up", thumbs_down: "thumbs-down", pencil: "pencil", chart: "chart-column", thought: "message-circle",
  compass: "compass", receipt: "receipt", stop: "octagon-x", thread: "message-square", paperclip: "paperclip", zap: "zap",
  play: "play", scissors: "scissors", link: "link", retry: "rotate-ccw", sparkles: "sparkles", puzzle: "puzzle",
  clipboard: "clipboard-list", moon: "moon", calculator: "calculator", bandage: "bandage", eye: "eye", hourglass: "hourglass",
  wrench: "wrench", clock: "clock", bookmark: "bookmark", bell: "bell", file: "file-text", info: "info", flag: "flag",
  target: "target", key: "key", book: "book-open", flame: "flame", rocket: "rocket", mail: "mail", user: "user",
  shield: "shield", gauge: "gauge", trending_up: "trending-up", calendar: "calendar", lightbulb: "lightbulb", loader: "loader",
  circle_check: "circle-check", circle_x: "circle-x", pause: "pause", forward: "chevrons-right", memory: "database",
  // 2026-09-23 second pass — "optimal icons throughout" (Operator)
  arrow_right: "arrow-right", messages_square: "messages-square", bot: "bot", layers: "layers", hash: "hash", settings: "settings", activity: "activity", inbox: "inbox",
};
const DOTS = { dot_red: "#ed4245", dot_yellow: "#faa61a", dot_green: "#3ba55d", dot_grey: "#80848e", dot_blue: "#5865f2" };
let ok = 0, missing = [];
for (const [name, lucide] of Object.entries(SET)) {
  const r = await fetch(`https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/${lucide}.svg`);
  if (!r.ok) { missing.push(`${name}(${lucide})`); continue; }
  let svg = await r.text();
  svg = svg.replace('stroke="currentColor"', `stroke="${STROKE}"`).replace(/width="24"/, 'width="128"').replace(/height="24"/, 'height="128"');
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  writeFileSync(`${OUT}/cc_${name}.png`, png); ok++;
}
for (const [name, color] of Object.entries(DOTS)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="${color}"/></svg>`;
  writeFileSync(`${OUT}/cc_${name}.png`, await sharp(Buffer.from(svg)).png().toBuffer()); ok++;
}
console.log(`rendered ${ok} icons → ${OUT}; missing: ${missing.join(", ") || "none"}`);
