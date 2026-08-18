import { describe, expect, it } from "@effect/vitest";

import { TERMINAL_COMPUTE_EXECUTION_STATUSES, type ComputeExecutionStatus } from "./contract.ts";
import {
  InvalidComputeExecutionTransitionError,
  transitionComputeExecutionStatus,
} from "./executionStateMachine.ts";

// Stated independently of the implementation on purpose: a table derived from
// the one under test would agree with any mistake in it.
const STATUSES: ReadonlyArray<ComputeExecutionStatus> = [
  "queued",
  "submitting",
  "running",
  "succeeded",
  "failed",
  "interrupting",
  "cancelled",
  "lost",
];

const LEGAL: ReadonlyArray<readonly [ComputeExecutionStatus, ComputeExecutionStatus]> = [
  ["queued", "submitting"],
  ["queued", "cancelled"],
  ["queued", "lost"],
  ["submitting", "running"],
  ["submitting", "failed"],
  ["submitting", "cancelled"],
  ["submitting", "lost"],
  ["running", "succeeded"],
  ["running", "failed"],
  ["running", "interrupting"],
  ["running", "cancelled"],
  ["running", "lost"],
  ["interrupting", "cancelled"],
  ["interrupting", "succeeded"],
  ["interrupting", "failed"],
  ["interrupting", "lost"],
];

const isLegal = (current: ComputeExecutionStatus, next: ComputeExecutionStatus): boolean =>
  LEGAL.some(([from, to]) => from === current && to === next);

describe("compute execution state machine", () => {
  it("permits exactly the transitions the lifecycle allows", () => {
    for (const current of STATUSES) {
      for (const next of STATUSES) {
        if (current === next) {
          expect(transitionComputeExecutionStatus(current, next)).toBe(current);
          continue;
        }
        if (isLegal(current, next)) {
          expect(transitionComputeExecutionStatus(current, next)).toBe(next);
          continue;
        }
        expect(() => transitionComputeExecutionStatus(current, next)).toThrow(
          InvalidComputeExecutionTransitionError,
        );
      }
    }
  });

  it("walks an execution that runs to completion", () => {
    let status = transitionComputeExecutionStatus("queued", "submitting");
    status = transitionComputeExecutionStatus(status, "running");
    status = transitionComputeExecutionStatus(status, "succeeded");

    expect(status).toBe("succeeded");
  });

  it("cancels queued work without pretending it was interrupted", () => {
    expect(transitionComputeExecutionStatus("queued", "cancelled")).toBe("cancelled");
    expect(() => transitionComputeExecutionStatus("queued", "interrupting")).toThrow(
      InvalidComputeExecutionTransitionError,
    );
  });

  it("lets an interrupt lose the race to the code it targeted", () => {
    const interrupting = transitionComputeExecutionStatus("running", "interrupting");

    expect(transitionComputeExecutionStatus(interrupting, "succeeded")).toBe("succeeded");
    expect(transitionComputeExecutionStatus(interrupting, "failed")).toBe("failed");
    expect(transitionComputeExecutionStatus(interrupting, "cancelled")).toBe("cancelled");
  });

  it("cancels running work when its namespace is deliberately destroyed", () => {
    expect(transitionComputeExecutionStatus("running", "cancelled")).toBe("cancelled");
  });

  it("leaves every terminal status without a successor", () => {
    for (const terminal of TERMINAL_COMPUTE_EXECUTION_STATUSES) {
      for (const next of STATUSES) {
        if (next === terminal) continue;
        expect(() => transitionComputeExecutionStatus(terminal, next)).toThrow(
          InvalidComputeExecutionTransitionError,
        );
      }
    }
  });
});
