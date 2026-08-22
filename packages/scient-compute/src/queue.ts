import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ComputeExecutionId } from "./contract.ts";
import { Count } from "./primitives.ts";

/**
 * Who runs next, as a pure function of who is waiting.
 *
 * One namespace can run one thing at a time: a kernel executing two statements
 * concurrently would interleave their effects on shared state, so an ordering
 * is not a scheduling nicety but the only way dependent code means anything.
 * That ordering is the part of a session easiest to get subtly wrong -- a cancel
 * that removes the wrong entry, a position that drifts from what a user was
 * shown, a restart that leaves work queued against a namespace that no longer
 * exists -- so it lives here, as a total reducer with no clock, no I/O, and no
 * Effect except where a caller genuinely has to be refused.
 *
 * A queue only ever holds entries for the session's current namespace: a
 * restart drains it, and a command written against an older generation is
 * refused before it can be admitted. So no entry carries a generation --
 * duplicating that guarantee here would put it somewhere it could disagree with
 * the record.
 */

/**
 * How many executions may wait behind the running one.
 *
 * A bound rather than a stream: unbounded queueing turns a stuck kernel into
 * unbounded memory and hands a user a backlog they can no longer reason about.
 * Sixteen is a working session's depth -- deep enough that a burst of cells does
 * not bounce, shallow enough that the queue is still something a person can
 * read.
 */
export const MAXIMUM_PENDING_COMPUTE_EXECUTIONS = 16;

export interface ComputeQueueState {
  readonly active: ComputeExecutionId | null;
  readonly pending: ReadonlyArray<ComputeExecutionId>;
}

export const EMPTY_COMPUTE_QUEUE: ComputeQueueState = { active: null, pending: [] };

/**
 * A queue that is already as full as it is allowed to get.
 *
 * Typed because it is the one queue outcome a user has to be told about, and
 * because the number they have to be told is the limit rather than the message.
 * A caller that refused with a string would leave a client unable to say
 * "sixteen already waiting" without parsing prose.
 */
export class ComputeQueueFullError extends Schema.TaggedErrorClass<ComputeQueueFullError>()(
  "ComputeQueueFullError",
  {
    limit: Count,
    pending: Count,
  },
) {
  override get message(): string {
    return `The session already has ${this.pending} executions waiting, which is its limit of ${this.limit}.`;
  }
}

/** Where an execution sits, counting the running one as zero. */
export function computeQueuePositionOf(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): number | null {
  if (state.active === executionId) return 0;
  const index = state.pending.indexOf(executionId);
  if (index < 0) return null;
  return state.active === null ? index : index + 1;
}

export function computeQueueDepth(state: ComputeQueueState): number {
  return (state.active === null ? 0 : 1) + state.pending.length;
}

/**
 * Accepts an execution, or refuses because too many are already waiting.
 *
 * A resubmitted identifier keeps its place rather than being appended again.
 * Two entries for one execution would make the queue disagree with the record,
 * and a retried command must not cost a user a second slot.
 */
export function admitComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): Effect.Effect<{ state: ComputeQueueState; position: number }, ComputeQueueFullError> {
  const existing = computeQueuePositionOf(state, executionId);
  if (existing !== null) return Effect.succeed({ state, position: existing });
  if (state.pending.length >= MAXIMUM_PENDING_COMPUTE_EXECUTIONS) {
    return Effect.fail(
      new ComputeQueueFullError({
        limit: MAXIMUM_PENDING_COMPUTE_EXECUTIONS,
        pending: state.pending.length,
      }),
    );
  }
  const next: ComputeQueueState = {
    active: state.active,
    pending: [...state.pending, executionId],
  };
  return Effect.succeed({
    state: next,
    // Non-null by construction: the entry was just appended.
    position: computeQueuePositionOf(next, executionId) ?? next.pending.length,
  });
}

/**
 * Promotes the head of the queue, if nothing is running.
 *
 * Returns null rather than failing when there is nothing to promote, because
 * both reasons -- something is already running, nothing is waiting -- are
 * ordinary and the caller does the same thing in either case.
 */
export function startNextComputeExecution(state: ComputeQueueState): {
  readonly state: ComputeQueueState;
  readonly started: ComputeExecutionId | null;
} {
  if (state.active !== null) return { state, started: null };
  const [head, ...rest] = state.pending;
  if (head === undefined) return { state, started: null };
  return { state: { active: head, pending: rest }, started: head };
}

/**
 * Clears the running execution.
 *
 * Ignores an identifier that is not the active one. A completion for something
 * this queue does not think is running is a late report about a namespace that
 * has moved on, and treating it as an error would turn a harmless race into a
 * failed command.
 */
export function finishComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): ComputeQueueState {
  if (state.active !== executionId) return state;
  return { active: null, pending: state.pending };
}

/**
 * Removes an execution, and says where it was removed from.
 *
 * The distinction is the caller's whole decision: a pending execution is
 * cancelled by forgetting it, while an active one is still inside a runtime and
 * has to be interrupted. Collapsing them would either leak a running
 * computation or send a signal on behalf of code that never started.
 */
export function cancelComputeExecution(
  state: ComputeQueueState,
  executionId: ComputeExecutionId,
): {
  readonly state: ComputeQueueState;
  readonly removed: "active" | "pending" | null;
} {
  if (state.active === executionId) {
    return { state, removed: "active" };
  }
  if (!state.pending.includes(executionId)) return { state, removed: null };
  return {
    state: {
      active: state.active,
      pending: state.pending.filter((candidate) => candidate !== executionId),
    },
    removed: "pending",
  };
}

/**
 * Empties the queue for a restart or a shutdown, and reports what it held.
 *
 * Queued code was written against a namespace that is about to stop existing,
 * so running it afterwards would execute it against state its author never saw.
 * The cancelled entries are returned rather than dropped: an execution that
 * disappears without a terminal record is a hole in the history this service
 * exists to keep.
 */
export function drainComputeQueue(state: ComputeQueueState): {
  readonly state: ComputeQueueState;
  readonly active: ComputeExecutionId | null;
  readonly cancelled: ReadonlyArray<ComputeExecutionId>;
} {
  return { state: EMPTY_COMPUTE_QUEUE, active: state.active, cancelled: state.pending };
}

/** The pending entries with the positions a client should be shown. */
export function computeQueueEntries(
  state: ComputeQueueState,
): ReadonlyArray<{ readonly executionId: ComputeExecutionId; readonly position: number }> {
  const offset = state.active === null ? 0 : 1;
  return state.pending.map((executionId, index) => ({ executionId, position: index + offset }));
}
