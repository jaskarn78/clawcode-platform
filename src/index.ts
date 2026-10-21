/**
 * ClawCode public API.
 *
 * Re-exports core modules for programmatic usage by consumers
 * who want to use ClawCode without the CLI.
 */

// Config loading and resolution
export { loadConfig, resolveAllAgents, resolveAgentConfig } from "./config/loader.js";

// Config schema and types
export { configSchema } from "./config/schema.js";
export type { Config, AgentConfig } from "./config/schema.js";

// Workspace creation
export { createWorkspace, createWorkspaces } from "./agent/workspace.js";

// Shared types
export type { ResolvedAgentConfig, WorkspaceResult } from "./shared/types.js";

// Errors
export {
  ConfigValidationError,
  ConfigFileNotFoundError,
  WorkspaceError,
  ManagerError,
  ManagerNotRunningError,
  SessionError,
  IpcError,
} from "./shared/errors.js";

// Session manager
export { SessionManager } from "./manager/session-manager.js";
export type { SessionManagerOptions } from "./manager/session-manager.js";

// Manager types
export type {
  AgentStatus,
  RegistryEntry,
  Registry,
  BackoffConfig,
  AgentSessionConfig,
} from "./manager/types.js";
export { DEFAULT_BACKOFF_CONFIG } from "./manager/types.js";

// Registry
export {
  readRegistry,
  writeRegistry,
  createEntry,
  updateEntry,
  EMPTY_REGISTRY,
} from "./manager/registry.js";

// Daemon
export {
  startDaemon,
  SOCKET_PATH,
  PID_PATH,
  MANAGER_DIR,
  REGISTRY_PATH,
} from "./manager/daemon.js";

// Session adapter
export type { SessionAdapter, SessionHandle } from "./manager/session-adapter.js";

// IPC client
export { sendIpcRequest } from "./ipc/client.js";
