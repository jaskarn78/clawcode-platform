/**
 * ClawCode version constant.
 *
 * Bundled at compile time so it survives tsup's ESM bundling without
 * needing a runtime `require('package.json')`. Keep in sync with the
 * `version` field in package.json; CI does not enforce this yet.
 */
export const CLAWCODE_VERSION = "1.2.8" as const;
