import type { ComputeExecutionStatus } from "./contract.ts";

/**
 * Lifecycle transitions an execution may take.
 *
 * `queued` reaches `cancelled` directly: work a user withdrew before it was
 * handed to a runtime never ran, and pretending it was interrupted would
 * misreport it.
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
 * Every state reaches `lost`, because the runtime holding an execution can
 * disappear at any moment and the execution's real outcome becomes unknowable.
 * `lost` is distinct from `failed`: nothing about the user's code was wrong.
 */
const ALLOWED_EXECUTION_TRANSITIONS: Readonly<
  Record<ComputeExecutionStatus, ReadonlySet<ComputeExecutionStatus>>
> = {
  queued: new Set(["submitting", "cancelled", "lost"]),
  submitting: new Set(["running", "failed", "cancelled", "lost"]),
  running: new Set(["succeeded", "failed", "interrupting", "cancelled", "lost"]),
  interrupting: new Set(["cancelled", "succeeded", "failed", "lost"]),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  lost: new Set(),
};

export class InvalidComputeExecutionTransitionError extends Error {
  readonly current: ComputeExecutionStatus;
  readonly next: ComputeExecutionStatus;

  constructor(current: ComputeExecutionStatus, next: ComputeExecutionStatus) {
    super(`Compute execution status cannot transition from '${current}' to '${next}'.`);
    this.name = "InvalidComputeExecutionTransitionError";
    this.current = current;
    this.next = next;
  }
}

export function transitionComputeExecutionStatus(
  current: ComputeExecutionStatus,
  next: ComputeExecutionStatus,
): ComputeExecutionStatus {
  if (current === next) return current;
  if (!ALLOWED_EXECUTION_TRANSITIONS[current].has(next)) {
    throw new InvalidComputeExecutionTransitionError(current, next);
  }
  return next;
}
