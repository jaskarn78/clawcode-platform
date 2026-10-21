import { connect } from "node:net";
import { nanoid } from "nanoid";
import { ipcResponseSchema } from "./protocol.js";
import type { IpcRequest } from "./protocol.js";
import { IpcError, ManagerNotRunningError } from "../shared/errors.js";

/**
 * Send a JSON-RPC request to the daemon over a Unix socket.
 * Returns the result on success, throws IpcError or ManagerNotRunningError on failure.
 *
 * @param socketPath - Path to the Unix domain socket
 * @param method - The IPC method to call
 * @param params - Parameters for the method
 * @returns The result from the daemon
 */
export async function sendIpcRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);

    const request: IpcRequest = {
      jsonrpc: "2.0",
      id: nanoid(),
      method: method as IpcRequest["method"],
      params,
    };

    let data = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      data += chunk.toString();

      // Check for complete message (newline-delimited)
      const newlineIndex = data.indexOf("\n");
      if (newlineIndex !== -1) {
        const message = data.slice(0, newlineIndex);
        processResponse(message, resolve, reject);
        socket.destroy();
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED" || err.code === "ENOENT") {
        reject(new ManagerNotRunningError());
      } else {
        reject(err);
      }
    });

    socket.on("end", () => {
      // If we got data but no newline, try to parse what we have
      if (data.length > 0 && !data.includes("\n")) {
        processResponse(data, resolve, reject);
      }
    });
  });
}

/**
 * Parse and process a JSON-RPC response.
 */
function processResponse(
  raw: string,
  resolve: (value: unknown) => void,
  reject: (error: Error) => void,
): void {
  try {
    const parsed: unknown = JSON.parse(raw);
    const result = ipcResponseSchema.safeParse(parsed);

    if (!result.success) {
      reject(new IpcError("Invalid response from daemon", -32600));
      return;
    }

    const response = result.data;

    if (response.error) {
      // Phase 86 Plan 03 — preserve the JSON-RPC error envelope's `data`
      // field on the IpcError so domain-specific consumers (e.g.
      // /clawcode-model's ModelNotAllowedError renderer) can read
      // `err.data.kind` without a second round-trip.
      reject(
        new IpcError(
          response.error.message,
          response.error.code,
          response.error.data,
        ),
      );
      return;
    }

    resolve(response.result);
  } catch {
    reject(new IpcError("Failed to parse daemon response", -32700));
  }
}
