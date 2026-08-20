import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ComputeSessionStatus, type ComputeSessionGeneration } from "./contract.ts";

/**
 * Lifecycle transitions a session may take.
 *
 * `stopping` is reachable from `starting` and `restarting` because a user may
 * abandon a session that is still coming up, and abandoning it must not have to
 * wait for it to succeed first.
 *
 * The three terminal states are genuinely terminal. A session that stopped,
 * failed to start, or was lost is a finished record; continuing work means a
 * new session with a new namespace, which is what a user asking to "restart a
 * dead session" actually gets. Reviving a record would leave its executions
 * attributed to a namespace that no longer exists.
 *
 * Activity (`idle`, `busy`, `unresponsive`) has no table: every change between
 * those three is legal, including `unresponsive` back to `busy` when a late
 * heartbeat arrives while work continues.
 */
const ALLOWED_SESSION_TRANSITIONS: Readonly<
  Record<ComputeSessionStatus, ReadonlySet<ComputeSessionStatus>>
> = {
  starting: new Set(["ready", "stopping", "failed", "lost"]),
  ready: new Set(["restarting", "stopping", "failed", "lost"]),
  restarting: new Set(["ready", "stopping", "failed", "lost"]),
  stopping: new Set(["stopped", "failed", "lost"]),
  stopped: new Set(),
  failed: new Set(),
  lost: new Set(),
};

/**
 * A transition the lifecycle does not allow.
 *
 * Typed for the same reason as its execution counterpart: recovery reads a
 * stored status back, so an impossible pair is data to report rather than a
 * defect to crash on.
 */
export class InvalidComputeSessionTransitionError extends Schema.TaggedErrorClass<InvalidComputeSessionTransitionError>()(
  "InvalidComputeSessionTransitionError",
  {
    current: ComputeSessionStatus,
    next: ComputeSessionStatus,
  },
) {
  override get message(): string {
    return `Compute session status cannot transition from '${this.current}' to '${this.next}'.`;
  }
}

export function transitionComputeSessionStatus(
  current: ComputeSessionStatus,
  next: ComputeSessionStatus,
): Effect.Effect<ComputeSessionStatus, InvalidComputeSessionTransitionError> {
  if (current === next) return Effect.succeed(current);
  if (!ALLOWED_SESSION_TRANSITIONS[current].has(next)) {
    return Effect.fail(new InvalidComputeSessionTransitionError({ current, next }));
  }
  return Effect.succeed(next);
}

/**
 * Whether a command written against one namespace may still run.
 *
 * `stale` and `ahead` are separated because they mean different things and
 * deserve different answers: a stale command comes from a client that has not
 * yet seen a restart and is told the session moved on, while an ahead command
 * cannot be explained by a client observing the truth and is a defect worth
 * reporting rather than a message worth showing.
 */
export type ComputeGenerationCheck =
  | { readonly _tag: "current" }
  | { readonly _tag: "stale"; readonly currentGeneration: ComputeSessionGeneration }
  | { readonly _tag: "ahead"; readonly currentGeneration: ComputeSessionGeneration };

export function checkComputeSessionGeneration(
  currentGeneration: ComputeSessionGeneration,
  expectedGeneration: ComputeSessionGeneration,
): ComputeGenerationCheck {
  if (expectedGeneration === currentGeneration) return { _tag: "current" };
  if (expectedGeneration < currentGeneration) return { _tag: "stale", currentGeneration };
  return { _tag: "ahead", currentGeneration };
}
