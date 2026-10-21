import { describe, it, expect } from "vitest";
import { TASK_STATUSES, LEGAL_TRANSITIONS, type TaskStatus } from "../types.js";
import {
  assertLegalTransition,
  isTerminal,
  isInFlight,
} from "../state-machine.js";
import { IllegalTaskTransitionError } from "../errors.js";

describe("assertLegalTransition — explicit legal paths", () => {
  it("Test 1: pending → running is legal", () => {
    expect(() => assertLegalTransition("pending", "running")).not.toThrow();
  });

  it("Test 2: pending → cancelled is legal", () => {
    expect(() => assertLegalTransition("pending", "cancelled")).not.toThrow();
  });

  it("Test 3: running → complete is legal", () => {
    expect(() => assertLegalTransition("running", "complete")).not.toThrow();
  });

  it("Test 4: running → awaiting_input is legal", () => {
    expect(() => assertLegalTransition("running", "awaiting_input")).not.toThrow();
  });

  it("Test 5: running → failed/cancelled/timed_out are all legal", () => {
    expect(() => assertLegalTransition("running", "failed")).not.toThrow();
    expect(() => assertLegalTransition("running", "cancelled")).not.toThrow();
    expect(() => assertLegalTransition("running", "timed_out")).not.toThrow();
  });

  it("Test 6: awaiting_input → running/cancelled/timed_out are all legal", () => {
    expect(() => assertLegalTransition("awaiting_input", "running")).not.toThrow();
    expect(() => assertLegalTransition("awaiting_input", "cancelled")).not.toThrow();
    expect(() => assertLegalTransition("awaiting_input", "timed_out")).not.toThrow();
  });
});

describe("assertLegalTransition — terminal status outbound rejection", () => {
  it("Test 7: complete → anything throws IllegalTaskTransitionError", () => {
    for (const s of TASK_STATUSES) {
      expect(() => assertLegalTransition("complete", s)).toThrow(
        IllegalTaskTransitionError,
      );
    }
  });

  it("Test 8a: failed → anything throws IllegalTaskTransitionError", () => {
    for (const s of TASK_STATUSES) {
      expect(() => assertLegalTransition("failed", s)).toThrow(
        IllegalTaskTransitionError,
      );
    }
  });

  it("Test 8b: cancelled → anything throws IllegalTaskTransitionError", () => {
    for (const s of TASK_STATUSES) {
      expect(() => assertLegalTransition("cancelled", s)).toThrow(
        IllegalTaskTransitionError,
      );
    }
  });

  it("Test 8c: timed_out → anything throws IllegalTaskTransitionError", () => {
    for (const s of TASK_STATUSES) {
      expect(() => assertLegalTransition("timed_out", s)).toThrow(
        IllegalTaskTransitionError,
      );
    }
  });

  it("Test 8d: orphaned → anything throws IllegalTaskTransitionError", () => {
    for (const s of TASK_STATUSES) {
      expect(() => assertLegalTransition("orphaned", s)).toThrow(
        IllegalTaskTransitionError,
      );
    }
  });
});

describe("assertLegalTransition — illegal status-skipping", () => {
  it("Test 9: pending → complete is illegal (skips running)", () => {
    expect(() => assertLegalTransition("pending", "complete")).toThrow(
      IllegalTaskTransitionError,
    );
  });
});

describe("assertLegalTransition — exhaustive (from, to) table", () => {
  for (const from of TASK_STATUSES) {
    for (const to of TASK_STATUSES) {
      const allowed = LEGAL_TRANSITIONS.get(from) ?? [];
      const isLegal = allowed.includes(to);
      it(`${from} → ${to} is ${isLegal ? "legal" : "illegal"}`, () => {
        if (isLegal) {
          expect(() => assertLegalTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertLegalTransition(from, to)).toThrow(
            IllegalTaskTransitionError,
          );
        }
      });
    }
  }
});

describe("IllegalTaskTransitionError shape from a thrown transition", () => {
  it("Test 11: complete → running throws IllegalTaskTransitionError with .from / .to / .name", () => {
    let caught: unknown;
    try {
      assertLegalTransition("complete", "running");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IllegalTaskTransitionError);
    const err = caught as IllegalTaskTransitionError;
    expect(err.from).toBe<TaskStatus>("complete");
    expect(err.to).toBe<TaskStatus>("running");
    expect(err.name).toBe("IllegalTaskTransitionError");
  });
});

describe("isTerminal helper", () => {
  it("Test 12: returns true for the 5 terminal statuses, false otherwise", () => {
    expect(isTerminal("complete")).toBe(true);
    expect(isTerminal("failed")).toBe(true);
    expect(isTerminal("cancelled")).toBe(true);
    expect(isTerminal("timed_out")).toBe(true);
    expect(isTerminal("orphaned")).toBe(true);
    expect(isTerminal("running")).toBe(false);
    expect(isTerminal("pending")).toBe(false);
    expect(isTerminal("awaiting_input")).toBe(false);
  });
});

describe("isInFlight helper", () => {
  it("Test 13: returns true for running/awaiting_input, false for the other 6", () => {
    expect(isInFlight("running")).toBe(true);
    expect(isInFlight("awaiting_input")).toBe(true);
    expect(isInFlight("pending")).toBe(false);
    expect(isInFlight("complete")).toBe(false);
    expect(isInFlight("failed")).toBe(false);
    expect(isInFlight("cancelled")).toBe(false);
    expect(isInFlight("timed_out")).toBe(false);
    expect(isInFlight("orphaned")).toBe(false);
  });
});
