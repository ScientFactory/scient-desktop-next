import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

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

const transition = transitionComputeSessionStatus;

// `flip` turns the refusal into the value under test, so a transition that
// wrongly succeeds fails the test instead of being asserted about.
const refusal = (
  current: ComputeSessionStatus,
  next: ComputeSessionStatus,
): Effect.Effect<InvalidComputeSessionTransitionError, ComputeSessionStatus> =>
  Effect.flip(transitionComputeSessionStatus(current, next));

describe("compute session state machine", () => {
  it.effect("permits exactly the transitions the lifecycle allows", () =>
    Effect.gen(function* () {
      for (const current of STATUSES) {
        for (const next of STATUSES) {
          if (current === next) {
            expect(yield* transition(current, next)).toBe(current);
            continue;
          }
          if (isLegal(current, next)) {
            expect(yield* transition(current, next)).toBe(next);
            continue;
          }
          expect((yield* refusal(current, next))._tag).toBe("InvalidComputeSessionTransitionError");
        }
      }
    }),
  );

  it.effect("walks a session that restarts and is then stopped", () =>
    Effect.gen(function* () {
      let status = yield* transition("starting", "ready");
      status = yield* transition(status, "restarting");
      status = yield* transition(status, "ready");
      status = yield* transition(status, "stopping");
      status = yield* transition(status, "stopped");

      expect(status).toBe("stopped");
    }),
  );

  it.effect("leaves every terminal status without a successor", () =>
    Effect.gen(function* () {
      for (const terminal of TERMINAL_COMPUTE_SESSION_STATUSES) {
        for (const next of STATUSES) {
          if (next === terminal) continue;
          expect((yield* refusal(terminal, next)).current).toBe(terminal);
        }
      }
    }),
  );

  it.effect("reports why the caller is holding it wrong", () =>
    Effect.gen(function* () {
      const error = yield* refusal("stopped", "ready");

      expect(error.message).toBe(
        "Compute session status cannot transition from 'stopped' to 'ready'.",
      );
      expect([error.current, error.next]).toEqual(["stopped", "ready"]);
    }),
  );
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
