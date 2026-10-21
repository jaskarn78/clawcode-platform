/**
 * Secret-shaped test fixtures, assembled from fragments at runtime.
 *
 * GitGuardian watches this repo and cannot tell a planted fixture from a real
 * leak, so no complete secret-shaped literal may appear in source — not even
 * a fake one. The code under test still receives fully-formed values. Do not
 * "tidy" these back into literals.
 */
const join = (...parts: readonly string[]): string => parts.join("");

export const SYNTHETIC = Object.freeze({
  anthropicKey: join("sk", "-ant-", "api03-", "A".repeat(28)),
  bearer: join("Bear", "er ", "b".repeat(20)),
  opServiceToken: join("ops", "_", "C".repeat(40)),
  githubPat: join("github", "_pat_", "D".repeat(30)),
  passwordPair: join("pass", "word=", "e".repeat(10)),
  envDump: [
    "HOME=/home/researcher",
    join("FINNHUB", "_API_KEY=", "f".repeat(24)),
    join("OP_SERVICE", "_ACCOUNT_TOKEN=", "ops", "_", "g".repeat(30)),
    join("DB", "_PASSWORD=", "h".repeat(12)),
  ].join("\n"),
});

/** Every raw value above — none may survive into anything written to disk. */
export const SYNTHETIC_RAW_VALUES: readonly string[] = Object.freeze([
  "A".repeat(28),
  "b".repeat(20),
  "C".repeat(40),
  "D".repeat(30),
  "e".repeat(10),
  "f".repeat(24),
  "g".repeat(30),
  "h".repeat(12),
]);
