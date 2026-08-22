import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputeExecutionStatus } from "./contract.ts";

/**
 * Lifecycle transitions an execution may take.
 *
 * `queued` reaches `cancelled` directly: work a user withdrew before it was
 * handed to a runtime never ran, and pretending it was interrupted would
 * misreport it.
 *
 * `submitting` reaches `interrupting` because a user can press stop while the
 * command is still on the wire. Refusing that would either drop the request or
 * force a caller to wait for `running` it may never see, and the runtime
 * answers an interrupt for an unknown execution honestly with `terminal`.
 *
 * `interrupting` reaches `succeeded` and `failed`, not only `cancelled`. An
 * interrupt is a request, and the code it targets is often finished before the
 * request lands. Recording that as a cancellation would tell a user their
 * result was thrown away when it was kept.
 *
 * `running` reaches `cancelled` directly when the namespace is deliberately
 * destroyed by restart or shutdown. That is not an interrupt: the transport
 * observed that the execution ended, so routing the transition through
 * `interrupting` would record an operation the user never requested.
 *
 * A rejected interrupt returns to `running`: requesting an interrupt changes
 * the observed activity, but a runtime that refuses it leaves the execution
 * alive.
 *
 * Every execution handed to a runtime can reach `lost`, because the runtime
 * can disappear before the outcome is known. Queued work cannot be lost: it
 * never left Scient, so recovery and session loss cancel it honestly.
 */
const ALLOWED_EXECUTION_TRANSITIONS: Readonly<
  Record<ComputeExecutionStatus, ReadonlySet<ComputeExecutionStatus>>
> = {
  queued: new Set(["submitting", "cancelled"]),
  submitting: new Set(["running", "failed", "interrupting", "cancelled", "lost"]),
  running: new Set(["succeeded", "failed", "interrupting", "cancelled", "lost"]),
  interrupting: new Set(["running", "cancelled", "succeeded", "failed", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

/**
 * A transition the lifecycle does not allow.
 *
 * It is a typed failure rather than a thrown defect because the current status
 * is often read back from durable storage, and a stored status that cannot
 * reach the one an event asks for is bad data, not unreachable code.
 */
export class InvalidComputeExecutionTransitionError extends Schema.TaggedErrorClass<InvalidComputeExecutionTransitionError>()(
  "InvalidComputeExecutionTransitionError",
  {
    current: ComputeExecutionStatus,
    next: ComputeExecutionStatus,
  },
) {
  override get message(): string {
    return `Compute execution status cannot transition from '${this.current}' to '${this.next}'.`;
  }
}

export function transitionComputeExecutionStatus(
  current: ComputeExecutionStatus,
  next: ComputeExecutionStatus,
): Effect.Effect<ComputeExecutionStatus, InvalidComputeExecutionTransitionError> {
  if (current === next) return Effect.succeed(current);
  if (!ALLOWED_EXECUTION_TRANSITIONS[current].has(next)) {
    return Effect.fail(new InvalidComputeExecutionTransitionError({ current, next }));
  }
  return Effect.succeed(next);
}
