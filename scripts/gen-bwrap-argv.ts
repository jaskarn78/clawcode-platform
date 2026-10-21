/**
 * One-shot validation helper (NOT shipped): emit the EXACT bwrap argv that
 * `buildBindArgs` generates for `personal` using its real clawdy paths, so the
 * generated argv (not a hand-typed approximation) can be fed to real bwrap on
 * the prod host. Prints one argv element per line for safe shell reconstruction.
 */
import { buildBindArgs, type SandboxBindPlan } from "../src/manager/bwrap-sandbox.js";

const personal: SandboxBindPlan = {
  enabled: true,
  admin: false,
  allowRuntimeOp: false,
  homeDir: "/home/clawcode",
  workspace: "/home/clawcode/.clawcode/agents/personal",
  memoryPath: "/home/clawcode/.clawcode/agents/personal",
  channelsStateDir: "/home/clawcode/.clawcode/channels-state/personal",
  managerSock: "/home/clawcode/.clawcode/manager/clawcode.sock",
  brokerSock: "/home/clawcode/.clawcode/manager/mcp-broker.sock",
  skillsPath: "/home/clawcode/.clawcode/skills",
  fileAccessRO: [],
  mcpDepPathsRO: [],
};

const argv = buildBindArgs(personal);
// NUL-delimited so any path with spaces survives; the consumer splits on \0.
process.stdout.write(argv.join("\0"));
