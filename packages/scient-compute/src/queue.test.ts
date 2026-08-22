import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ComputeExecutionId } from "./contract.ts";
import {
  admitComputeExecution,
  cancelComputeExecution,
  computeQueueDepth,
  computeQueueEntries,
  computeQueuePositionOf,
  drainComputeQueue,
  EMPTY_COMPUTE_QUEUE,
  finishComputeExecution,
  MAXIMUM_PENDING_COMPUTE_EXECUTIONS,
  startNextComputeExecution,
  type ComputeQueueFullError,
  type ComputeQueueState,
} from "./queue.ts";

const id = (value: string) => ComputeExecutionId.make(value);

/** Admits without unwrapping, for the many cases where admission cannot fail. */
const admit = (state: ComputeQueueState, executionId: string) =>
  admitComputeExecution(state, id(executionId));

// `flip` makes the refusal the value under test, so an admission that wrongly
// succeeds fails the test rather than being asserted about.
const refusal = (
  state: ComputeQueueState,
  executionId: string,
): Effect.Effect<ComputeQueueFullError, { state: ComputeQueueState; position: number }> =>
  Effect.flip(admit(state, executionId));

const fill = (count: number) =>
  Effect.gen(function* () {
    let state = EMPTY_COMPUTE_QUEUE;
    for (let index = 0; index < count; index += 1) {
      state = (yield* admit(state, `execution-${index}`)).state;
    }
    return state;
  });

describe("compute queue admission", () => {
  it.effect("gives the first submission the front of the queue", () =>
    Effect.gen(function* () {
      const { state, position } = yield* admit(EMPTY_COMPUTE_QUEUE, "first");
      expect(position).toBe(0);
      expect(state.active).toBeNull();
      expect(state.pending).toEqual([id("first")]);
    }),
  );

  it.effect("counts the running execution as the position ahead of the queue", () =>
    Effect.gen(function* () {
      const admitted = yield* admit(EMPTY_COMPUTE_QUEUE, "running");
      const { state: started } = startNextComputeExecution(admitted.state);
      const { position } = yield* admit(started, "waiting");
      // Not 0: something is already using the namespace, and a client told
      // "position 0" would show this as running.
      expect(position).toBe(1);
    }),
  );

  it.effect("keeps a resubmitted execution in the place it already had", () =>
    Effect.gen(function* () {
      const first = yield* admit(EMPTY_COMPUTE_QUEUE, "a");
      const second = yield* admit(first.state, "b");
      const again = yield* admit(second.state, "a");
      expect(again.position).toBe(0);
      expect(again.state.pending).toEqual([id("a"), id("b")]);
    }),
  );

  it.effect("refuses the seventeenth waiting execution and says what the limit is", () =>
    Effect.gen(function* () {
      const full = yield* fill(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
      const failure = yield* refusal(full, "one-too-many");
      expect(failure.limit).toBe(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
      expect(failure.pending).toBe(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
      expect(failure.message).toContain(String(MAXIMUM_PENDING_COMPUTE_EXECUTIONS));
    }),
  );

  it.effect("counts the limit against waiting work only, not against the running execution", () =>
    Effect.gen(function* () {
      const full = yield* fill(MAXIMUM_PENDING_COMPUTE_EXECUTIONS);
      const { state } = startNextComputeExecution(full);
      // One left the queue to run, so the queue has room again even though the
      // session now holds one more execution than the limit.
      const admitted = yield* admit(state, "next");
      expect(computeQueueDepth(admitted.state)).toBe(MAXIMUM_PENDING_COMPUTE_EXECUTIONS + 1);
    }),
  );
});

describe("compute queue progress", () => {
  it.effect("promotes the oldest waiting execution", () =>
    Effect.gen(function* () {
      const filled = yield* fill(3);
      const { state, started } = startNextComputeExecution(filled);
      expect(started).toBe(id("execution-0"));
      expect(state.active).toBe(id("execution-0"));
      expect(state.pending).toEqual([id("execution-1"), id("execution-2")]);
    }),
  );

  it.effect("promotes nothing while something is running", () =>
    Effect.gen(function* () {
      const filled = yield* fill(2);
      const running = startNextComputeExecution(filled).state;
      const again = startNextComputeExecution(running);
      expect(again.started).toBeNull();
      expect(again.state).toBe(running);
    }),
  );

  it("promotes nothing from an empty queue", () => {
    const { state, started } = startNextComputeExecution(EMPTY_COMPUTE_QUEUE);
    expect(started).toBeNull();
    expect(state).toBe(EMPTY_COMPUTE_QUEUE);
  });

  it.effect("frees the namespace when the running execution finishes", () =>
    Effect.gen(function* () {
      const filled = yield* fill(2);
      const running = startNextComputeExecution(filled).state;
      const finished = finishComputeExecution(running, id("execution-0"));
      expect(finished.active).toBeNull();
      expect(startNextComputeExecution(finished).started).toBe(id("execution-1"));
    }),
  );

  it.effect("ignores a completion for something it does not think is running", () =>
    Effect.gen(function* () {
      const filled = yield* fill(2);
      const running = startNextComputeExecution(filled).state;
      // A late report about a namespace that has moved on. Treating it as an
      // error would turn a harmless race into a failed command.
      expect(finishComputeExecution(running, id("execution-1"))).toBe(running);
      expect(finishComputeExecution(running, id("never-submitted"))).toBe(running);
    }),
  );
});

describe("compute queue cancellation", () => {
  it.effect("forgets a waiting execution and closes the gap behind it", () =>
    Effect.gen(function* () {
      const filled = yield* fill(3);
      const { state, removed } = cancelComputeExecution(filled, id("execution-1"));
      expect(removed).toBe("pending");
      expect(state.pending).toEqual([id("execution-0"), id("execution-2")]);
      expect(computeQueuePositionOf(state, id("execution-2"))).toBe(1);
    }),
  );

  it.effect("reports a running execution as active and leaves it in place", () =>
    Effect.gen(function* () {
      const filled = yield* fill(2);
      const running = startNextComputeExecution(filled).state;
      const { state, removed } = cancelComputeExecution(running, id("execution-0"));
      // It is inside a runtime; only an interrupt can end it, and forgetting it
      // here would leak the computation.
      expect(removed).toBe("active");
      expect(state.active).toBe(id("execution-0"));
    }),
  );

  it("reports nothing for an execution it has never seen", () => {
    const { state, removed } = cancelComputeExecution(EMPTY_COMPUTE_QUEUE, id("stranger"));
    expect(removed).toBeNull();
    expect(state).toBe(EMPTY_COMPUTE_QUEUE);
  });
});

describe("compute queue draining", () => {
  it.effect("empties the queue and hands back everything it was holding", () =>
    Effect.gen(function* () {
      const filled = yield* fill(3);
      const running = startNextComputeExecution(filled).state;
      const drained = drainComputeQueue(running);
      expect(drained.state).toEqual(EMPTY_COMPUTE_QUEUE);
      expect(drained.active).toBe(id("execution-0"));
      // Returned rather than dropped: an execution that disappears without a
      // terminal record is a hole in the history.
      expect(drained.cancelled).toEqual([id("execution-1"), id("execution-2")]);
    }),
  );

  it("drains an empty queue without inventing anything to cancel", () => {
    const drained = drainComputeQueue(EMPTY_COMPUTE_QUEUE);
    expect(drained.active).toBeNull();
    expect(drained.cancelled).toEqual([]);
  });
});

describe("compute queue positions", () => {
  it.effect("numbers waiting executions from behind the running one", () =>
    Effect.gen(function* () {
      const filled = yield* fill(3);
      const running = startNextComputeExecution(filled).state;
      expect(computeQueueEntries(running)).toEqual([
        { executionId: id("execution-1"), position: 1 },
        { executionId: id("execution-2"), position: 2 },
      ]);
    }),
  );

  it.effect("numbers waiting executions from the front when nothing is running", () =>
    Effect.gen(function* () {
      const filled = yield* fill(2);
      expect(computeQueueEntries(filled)).toEqual([
        { executionId: id("execution-0"), position: 0 },
        { executionId: id("execution-1"), position: 1 },
      ]);
    }),
  );

  it("has no position for an execution it does not hold", () => {
    expect(computeQueuePositionOf(EMPTY_COMPUTE_QUEUE, id("stranger"))).toBeNull();
  });
});
