import pino from "pino";

const LOG_LEVEL = process.env["CLAWCODE_LOG_LEVEL"] ?? "info";

/**
 * Shared logger instance for ClawCode.
 * Log level controlled via CLAWCODE_LOG_LEVEL environment variable.
 */
export const logger = pino({
  name: "clawcode",
  level: LOG_LEVEL,
});
