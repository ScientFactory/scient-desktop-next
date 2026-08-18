import * as Effect from "effect/Effect";
import * as MutableRef from "effect/MutableRef";
import type * as Cause from "effect/Cause";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  ComputeTransportError,
  nextComputeSessionGeneration,
  type ComputeCapability,
  type ComputeChannel,
  type ComputeOutput,
  type ComputeRequestId,
  type ComputeRuntimeIdentity,
  type ComputeSessionGeneration,
  type ComputeTransport,
  type ComputeTransportEvent,
  type ComputeTransportOpenRequest,
} from "./contract.ts";
import { missingComputeCapabilities } from "./capabilities.ts";

/**
 * What a scripted runtime does when it is given code.
 *
 * `runs-until-interrupted` exists so a test can hold an execution open without
 * a clock: races between running work and interrupt, restart, or shutdown are
 * the cases most likely to be wrong, and a simulator that always finished
 * immediately could not express them. Nothing here sleeps, so every ordering a
 * test observes is the ordering it asked for.
 */
export type SimulatedComputeExecution =
  | {
      readonly _tag: "completes";
      readonly outputs: ReadonlyArray<ComputeOutput>;
      readonly outcome: "succeeded" | "failed";
    }
  | { readonly _tag: "runs-until-interrupted"; readonly outputs: ReadonlyArray<ComputeOutput> }
  | { readonly _tag: "loses-runtime"; readonly reason: string };

export interface SimulatedComputeRuntime {
  readonly runtime: ComputeRuntimeIdentity;
  readonly capabilities: ReadonlyArray<ComputeCapability>;
  readonly resolveExecution: (code: string) => SimulatedComputeExecution;
}

function transportError(
  operation: ComputeTransportError["operation"],
  message: string,
): ComputeTransportError {
  return new ComputeTransportError({ operation, message });
}

/**
 * A runtime that exists only as a script.
 *
 * It is the proof that the session contracts describe a runtime rather than a
 * Python one: it speaks no language, runs no process, and still drives a
 * complete session lifecycle. Anything the coordinator can only do against a
 * real kernel is a leak of transport detail into the coordinator.
 */
export function createSimulatedComputeTransport(plan: SimulatedComputeRuntime): ComputeTransport {
  return {
    open(request: ComputeTransportOpenRequest) {
      return Effect.gen(function* () {
        const missing = missingComputeCapabilities(
          plan.capabilities,
          new Set(request.requiredCapabilities),
        );
        if (missing.length > 0) {
          return yield* transportError(
            "handshake",
            `The runtime does not support ${missing.join(", ")}.`,
          );
        }

        // `Done` is how a queue says it will produce nothing further, which is
        // what shutting the channel down means.
        const events = yield* Queue.unbounded<ComputeTransportEvent, Cause.Done>();
        const inFlight = MutableRef.make<ComputeRequestId | undefined>(undefined);
        const generation = MutableRef.make(request.generation);
        const closed = MutableRef.make(false);

        const emit = (event: ComputeTransportEvent) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        const finish = (
          requestId: ComputeRequestId,
          outcome: "succeeded" | "failed" | "cancelled",
        ) =>
          Effect.suspend(() => {
            MutableRef.set(inFlight, undefined);
            return emit({ _tag: "completed", requestId, outcome });
          });
        const whenOpen = (
          operation: ComputeTransportError["operation"],
          effect: Effect.Effect<void, ComputeTransportError>,
        ) =>
          Effect.suspend(() =>
            MutableRef.get(closed)
              ? Effect.fail(transportError(operation, "The runtime is no longer reachable."))
              : effect,
          );
        const requireCurrentGeneration = (
          operation: ComputeTransportError["operation"],
          expectedGeneration: ComputeSessionGeneration,
        ) =>
          Effect.suspend(() => {
            const currentGeneration = MutableRef.get(generation);
            return expectedGeneration === currentGeneration
              ? Effect.void
              : Effect.fail(
                  transportError(
                    operation,
                    `The command expected generation ${String(expectedGeneration)}, but the session is at generation ${String(currentGeneration)}.`,
                  ),
                );
          });
        const mutateCurrentGeneration = (
          operation: ComputeTransportError["operation"],
          expectedGeneration: ComputeSessionGeneration,
          effect: Effect.Effect<void, ComputeTransportError>,
        ) =>
          whenOpen(
            operation,
            requireCurrentGeneration(operation, expectedGeneration).pipe(Effect.andThen(effect)),
          );
        // Work in flight when the namespace goes away ends with it, whether it
        // was interrupted, restarted, or shut down.
        const settleInFlight = Effect.suspend(() => {
          const requestId = MutableRef.get(inFlight);
          return requestId === undefined ? Effect.void : finish(requestId, "cancelled");
        });
        const lose = (reason: string) =>
          Effect.suspend(() => {
            MutableRef.set(closed, true);
            return emit({ _tag: "lost", reason }).pipe(
              Effect.andThen(Queue.end(events)),
              Effect.asVoid,
            );
          });

        yield* emit({
          _tag: "ready",
          runtime: plan.runtime,
          capabilities: plan.capabilities,
        });

        const execute: ComputeChannel["execute"] = (executeRequest) =>
          mutateCurrentGeneration(
            "execute",
            executeRequest.expectedGeneration,
            Effect.suspend(() => {
              if (MutableRef.get(inFlight) !== undefined) {
                return Effect.fail(
                  transportError("execute", "The runtime is already running an execution."),
                );
              }
              MutableRef.set(inFlight, executeRequest.requestId);
              const scripted = plan.resolveExecution(executeRequest.code);
              if (scripted._tag === "loses-runtime") {
                return emit({ _tag: "accepted", requestId: executeRequest.requestId }).pipe(
                  Effect.andThen(lose(scripted.reason)),
                );
              }
              const announce = emit({
                _tag: "accepted",
                requestId: executeRequest.requestId,
              }).pipe(
                Effect.andThen(
                  Effect.forEach(
                    scripted.outputs,
                    (output) =>
                      emit({ _tag: "output", requestId: executeRequest.requestId, output }),
                    { discard: true },
                  ),
                ),
              );
              return scripted._tag === "completes"
                ? announce.pipe(Effect.andThen(finish(executeRequest.requestId, scripted.outcome)))
                : announce;
            }),
          );

        const interrupt: ComputeChannel["interrupt"] = (interruptRequest) =>
          mutateCurrentGeneration(
            "interrupt",
            interruptRequest.expectedGeneration,
            Effect.suspend(() => {
              const activeRequestId = MutableRef.get(inFlight);
              if (activeRequestId === undefined) return Effect.void;
              return activeRequestId === interruptRequest.requestId
                ? settleInFlight
                : Effect.fail(
                    transportError(
                      "interrupt",
                      `Execution '${interruptRequest.requestId}' is not the active execution.`,
                    ),
                  );
            }),
          );

        const restart: ComputeChannel["restart"] = (restartRequest) =>
          mutateCurrentGeneration(
            "restart",
            restartRequest.expectedGeneration,
            Effect.suspend(() => {
              const currentGeneration = MutableRef.get(generation);
              const requiredNextGeneration = nextComputeSessionGeneration(currentGeneration);
              if (restartRequest.nextGeneration !== requiredNextGeneration) {
                return Effect.fail(
                  transportError(
                    "restart",
                    `A restart from generation ${String(currentGeneration)} must create generation ${String(requiredNextGeneration)}.`,
                  ),
                );
              }
              return settleInFlight.pipe(
                Effect.andThen(
                  Effect.sync(() => MutableRef.set(generation, restartRequest.nextGeneration)),
                ),
                Effect.andThen(
                  emit({ _tag: "restarted", generation: restartRequest.nextGeneration }),
                ),
              );
            }),
          );

        const close = Effect.suspend(() => {
          if (MutableRef.get(closed)) return Effect.void;
          MutableRef.set(closed, true);
          return settleInFlight.pipe(Effect.andThen(Queue.end(events)), Effect.asVoid);
        });
        const shutdown: ComputeChannel["shutdown"] = (shutdownRequest) =>
          Effect.suspend(() =>
            MutableRef.get(closed)
              ? Effect.void
              : mutateCurrentGeneration("shutdown", shutdownRequest.expectedGeneration, close),
          );

        // A real runtime dies with the scope that owns it, so this one closes
        // too; a test that forgets to shut down still ends its event stream.
        yield* Effect.addFinalizer(() => close);

        return {
          events: Stream.fromQueue(events),
          execute,
          interrupt,
          restart,
          shutdown,
        } satisfies ComputeChannel;
      });
    },
  };
}
