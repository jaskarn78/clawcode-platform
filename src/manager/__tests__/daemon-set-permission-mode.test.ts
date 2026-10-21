/**
 * Phase 87 Plan 02 Task 2 — daemon IPC `set-permission-mode` handler tests (D1-D5).
 *
 * Drives the exported `handleSetPermissionModeIpc` pure function that the
 * daemon's `case "set-permission-mode":` delegates to. Mocks the
 * SessionManager surface via dependency injection.
 *
 * Pins:
 *   D1: success — dispatches manager.setPermissionModeForAgent once, returns
 *       the `{ok, agent, permission_mode}` envelope matching the set-effort
 *       shape.
 *   D2: missing `name` param → ManagerError.
 *   D3: missing `mode` param → ManagerError.
 *   D4: invalid mode surfaces as ManagerError listing valid modes; manager
 *       NOT called (validation happens inside SessionManager; the handler
 *       rethrows as ManagerError for the IPC envelope).
 *   D5: manager throws SessionError (unknown agent) → surfaces as ManagerError.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleSetPermissionModeIpc,
  type SetPermissionModeIpcDeps,
} from "../daemon.js";
import { ManagerError, SessionError } from "../../shared/errors.js";

type ManagerStub = SetPermissionModeIpcDeps["manager"];

function makeManagerStub(
  setPermissionModeForAgent: (name: string, mode: string) => void,
): ManagerStub {
  return {
    setPermissionModeForAgent: vi.fn(setPermissionModeForAgent),
  } as unknown as ManagerStub;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleSetPermissionModeIpc — Phase 87 Plan 02 (D1-D5)", () => {
  it("D1: success — dispatches manager.setPermissionModeForAgent once and returns the ok-envelope", async () => {
    const manager = makeManagerStub(() => {
      /* pass */
    });

    const result = await handleSetPermissionModeIpc({
      manager,
      params: { name: "clawdy", mode: "acceptEdits" },
    });

    expect(manager.setPermissionModeForAgent).toHaveBeenCalledTimes(1);
    expect(manager.setPermissionModeForAgent).toHaveBeenCalledWith(
      "clawdy",
      "acceptEdits",
    );
    expect(result).toEqual({
      ok: true,
      agent: "clawdy",
      permission_mode: "acceptEdits",
    });
  });

  it("D2: missing `name` param throws ManagerError", async () => {
    const manager = makeManagerStub(() => {
      /* should never be reached */
    });

    await expect(
      handleSetPermissionModeIpc({
        manager,
        params: { mode: "acceptEdits" },
      }),
    ).rejects.toThrow(ManagerError);

    expect(manager.setPermissionModeForAgent).not.toHaveBeenCalled();
  });

  it("D3: missing `mode` param throws ManagerError", async () => {
    const manager = makeManagerStub(() => {
      /* should never be reached */
    });

    await expect(
      handleSetPermissionModeIpc({
        manager,
        params: { name: "clawdy" },
      }),
    ).rejects.toThrow(ManagerError);

    expect(manager.setPermissionModeForAgent).not.toHaveBeenCalled();
  });

  it("D4: invalid mode surfaces as ManagerError listing valid modes", async () => {
    const manager = makeManagerStub((_name, mode) => {
      // Mirror the real SessionManager validation shape — throws a plain
      // Error listing valid modes when the input is not one of the 6.
      const validModes = [
        "default",
        "acceptEdits",
        "bypassPermissions",
        "plan",
        "dontAsk",
        "auto",
      ];
      if (!validModes.includes(mode)) {
        throw new Error(
          `Invalid permission mode '${mode}'. Valid: ${validModes.join(", ")}`,
        );
      }
    });

    let caught: unknown;
    try {
      await handleSetPermissionModeIpc({
        manager,
        params: { name: "clawdy", mode: "bogus" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ManagerError);
    const msg = (caught as ManagerError).message;
    expect(msg).toMatch(/invalid permission mode/i);
    expect(msg).toMatch(/acceptEdits/);
    // Manager was called once before rejecting.
    expect(manager.setPermissionModeForAgent).toHaveBeenCalledTimes(1);
  });

  it("D5: manager throws SessionError (unknown agent) → surfaces as ManagerError", async () => {
    const manager = makeManagerStub(() => {
      throw new SessionError("Agent 'ghost' is not running", "ghost");
    });

    let caught: unknown;
    try {
      await handleSetPermissionModeIpc({
        manager,
        params: { name: "ghost", mode: "acceptEdits" },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ManagerError);
    expect((caught as Error).message).toMatch(/not running/);
  });
});
