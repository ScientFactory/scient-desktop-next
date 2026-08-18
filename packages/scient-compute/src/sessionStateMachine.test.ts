import { describe, expect, it } from "@effect/vitest";

import {
  ComputeSessionGeneration,
  INITIAL_COMPUTE_SESSION_GENERATION,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  nextComputeSessionGeneration,
  type ComputeSessionStatus,
} from "./contract.ts";
import {
  InvalidComputeSessionTransitionError,
  checkComputeSessionGeneration,
  transitionComputeSessionStatus,
} from "./sessionStateMachine.ts";

// Stated independently of the implementation on purpose: a table derived from
// the one under test would agree with any mistake in it.
const STATUSES: ReadonlyArray<ComputeSessionStatus> = [
  "starting",
  "ready",
  "restarting",
  "stopping",
  "stopped",
  "failed",
  "lost",
];

const LEGAL: ReadonlyArray<readonly [ComputeSessionStatus, ComputeSessionStatus]> = [
  ["starting", "ready"],
  ["starting", "stopping"],
  ["starting", "failed"],
  ["starting", "lost"],
  ["ready", "restarting"],
  ["ready", "stopping"],
  ["ready", "failed"],
  ["ready", "lost"],
  ["restarting", "ready"],
  ["restarting", "stopping"],
  ["restarting", "failed"],
  ["restarting", "lost"],
  ["stopping", "stopped"],
  ["stopping", "failed"],
  ["stopping", "lost"],
];

const isLegal = (current: ComputeSessionStatus, next: ComputeSessionStatus): boolean =>
  LEGAL.some(([from, to]) => from === current && to === next);

describe("compute session state machine", () => {
  it("permits exactly the transitions the lifecycle allows", () => {
    for (const current of STATUSES) {
      for (const next of STATUSES) {
        if (current === next) {
          expect(transitionComputeSessionStatus(current, next)).toBe(current);
          continue;
        }
        if (isLegal(current, next)) {
          expect(transitionComputeSessionStatus(current, next)).toBe(next);
          continue;
        }
        expect(() => transitionComputeSessionStatus(current, next)).toThrow(
          InvalidComputeSessionTransitionError,
        );
      }
    }
  });

  it("walks a session that restarts and is then stopped", () => {
    let status = transitionComputeSessionStatus("starting", "ready");
    status = transitionComputeSessionStatus(status, "restarting");
    status = transitionComputeSessionStatus(status, "ready");
    status = transitionComputeSessionStatus(status, "stopping");
    status = transitionComputeSessionStatus(status, "stopped");

    expect(status).toBe("stopped");
  });

  it("leaves every terminal status without a successor", () => {
    for (const terminal of TERMINAL_COMPUTE_SESSION_STATUSES) {
      for (const next of STATUSES) {
        if (next === terminal) continue;
        expect(() => transitionComputeSessionStatus(terminal, next)).toThrow(
          InvalidComputeSessionTransitionError,
        );
      }
    }
  });

  it("reports why the caller is holding it wrong", () => {
    const error = new InvalidComputeSessionTransitionError("stopped", "ready");

    expect(error.message).toBe(
      "Compute session status cannot transition from 'stopped' to 'ready'.",
    );
    expect([error.current, error.next]).toEqual(["stopped", "ready"]);
  });
});

describe("compute session generations", () => {
  it("counts namespaces from one", () => {
    expect(INITIAL_COMPUTE_SESSION_GENERATION).toBe(1);
    expect(nextComputeSessionGeneration(INITIAL_COMPUTE_SESSION_GENERATION)).toBe(2);
  });

  it("refuses a generation no session ever had", () => {
    expect(() => ComputeSessionGeneration.make(0)).toThrow();
  });

  it("separates a client that fell behind from one that cannot be explained", () => {
    const current = ComputeSessionGeneration.make(3);

    expect(checkComputeSessionGeneration(current, ComputeSessionGeneration.make(3))).toEqual({
      _tag: "current",
    });
    expect(checkComputeSessionGeneration(current, ComputeSessionGeneration.make(2))).toEqual({
      _tag: "stale",
      currentGeneration: 3,
    });
    expect(checkComputeSessionGeneration(current, ComputeSessionGeneration.make(4))).toEqual({
      _tag: "ahead",
      currentGeneration: 3,
    });
  });
});
