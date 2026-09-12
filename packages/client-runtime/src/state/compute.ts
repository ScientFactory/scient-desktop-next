import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  WS_METHODS,
  computeOutputByteLength,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeSessionRecord,
  type ComputeSessionStreamEvent,
  ComputeLanguageId,
  type ComputeManagedRuntimeStatus,
  type EnvironmentId,
  type ScientificComputingSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** Progress polling belongs to shared state, not to whichever screen started setup. */
export function withManagedRuntimePolling<A extends ComputeManagedRuntimeStatus | null, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
) {
  return withActiveOperationPolling(source, (status) => status?.operation != null);
}

function withActiveOperationPolling<A, E>(
  source: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  active: (value: A) => boolean,
) {
  const polling = source.pipe(Atom.withRefresh("1 second"), Atom.setIdleTTL(0));
  return Atom.transform(source, (get) => {
    const result = get(source);
    return result._tag === "Success" && !result.waiting && active(result.value)
      ? get(polling)
      : result;
  }).pipe(Atom.setIdleTTL(0));
}

function managedRuntimeInspectionKey(status: ComputeManagedRuntimeStatus | null) {
  return JSON.stringify(
    status === null
      ? null
      : [
          status.installed,
          status.selection,
          status.generationId,
          status.runtimeVersion,
          status.toolkitRevision,
          status.operation?.operationId,
          status.failureMessage,
        ],
  );
}

const MAXIMUM_TERMINAL_SESSIONS = 32;
const MAXIMUM_EXECUTIONS_PER_SESSION = 100;
const MAXIMUM_LIVE_OUTPUT_PROJECTIONS = 32;
const MAXIMUM_LIVE_OUTPUT_ITEMS = 256;
const MAXIMUM_LIVE_OUTPUT_BYTES = 2 * 1024 * 1024;

export interface ComputeOutputProjection {
  readonly outputs: ReadonlyArray<ComputeOutput>;
  readonly bytes: number;
  readonly clipped: boolean;
  /** Monotonic for this bounded projection, even after the image item is evicted. */
  readonly hasImage: boolean;
}

export interface ComputeSubscriptionState {
  readonly snapshotBoundary: number | null;
  readonly expectedLiveSequence: number | null;
  readonly sessions: ReadonlyMap<string, ComputeSessionRecord>;
  readonly executions: ReadonlyMap<string, ReadonlyMap<string, ComputeExecutionRecord>>;
  readonly outputs: ReadonlyMap<string, ComputeOutputProjection>;
  readonly stale: boolean;
  readonly observedGap: { readonly expected: number; readonly received: number } | null;
}

export const EMPTY_COMPUTE_SUBSCRIPTION_STATE: ComputeSubscriptionState = {
  snapshotBoundary: null,
  expectedLiveSequence: null,
  sessions: new Map(),
  executions: new Map(),
  outputs: new Map(),
  stale: false,
  observedGap: null,
};

function outputKey(sessionId: string, executionId: string | null): string {
  return `${sessionId}/${executionId ?? "@session"}`;
}

function setBoundedSession(
  sessions: ReadonlyMap<string, ComputeSessionRecord>,
  session: ComputeSessionRecord,
): ReadonlyMap<string, ComputeSessionRecord> {
  const next = new Map(sessions);
  next.set(session.sessionId, session);
  const terminal = [...next.values()]
    .filter((candidate) => TERMINAL_COMPUTE_SESSION_STATUSES.has(candidate.status))
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt));
  for (const expired of terminal.slice(MAXIMUM_TERMINAL_SESSIONS)) {
    next.delete(expired.sessionId);
  }
  return next;
}

function retainProjectedSessions<T>(
  projections: ReadonlyMap<string, T>,
  sessions: ReadonlyMap<string, ComputeSessionRecord>,
): ReadonlyMap<string, T> {
  if ([...projections.keys()].every((sessionId) => sessions.has(sessionId))) return projections;
  return new Map([...projections].filter(([sessionId]) => sessions.has(sessionId)));
}

function retainSessionOutputs(
  projections: ReadonlyMap<string, ComputeOutputProjection>,
  sessions: ReadonlyMap<string, ComputeSessionRecord>,
): ReadonlyMap<string, ComputeOutputProjection> {
  const prefixes = [...sessions.keys()].map((sessionId) => `${sessionId}/`);
  if ([...projections.keys()].every((key) => prefixes.some((prefix) => key.startsWith(prefix)))) {
    return projections;
  }
  return new Map(
    [...projections].filter(([key]) => prefixes.some((prefix) => key.startsWith(prefix))),
  );
}

function applySessionRecord(
  state: ComputeSubscriptionState,
  session: ComputeSessionRecord,
): ComputeSubscriptionState {
  const sessions = setBoundedSession(state.sessions, session);
  return {
    ...state,
    sessions,
    executions: retainProjectedSessions(state.executions, sessions),
    outputs: retainSessionOutputs(state.outputs, sessions),
  };
}

function setBoundedExecution(
  executions: ReadonlyMap<string, ReadonlyMap<string, ComputeExecutionRecord>>,
  sessionId: string,
  execution: ComputeExecutionRecord,
): ReadonlyMap<string, ReadonlyMap<string, ComputeExecutionRecord>> {
  const sessionExecutions = new Map(executions.get(sessionId) ?? []);
  sessionExecutions.set(execution.request.executionId, execution);
  if (sessionExecutions.size > MAXIMUM_EXECUTIONS_PER_SESSION) {
    const terminal = [...sessionExecutions.values()]
      .filter(
        (candidate) =>
          candidate.result !== null &&
          TERMINAL_COMPUTE_EXECUTION_STATUSES.has(candidate.result.status),
      )
      .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt));
    for (const expired of terminal) {
      if (sessionExecutions.size <= MAXIMUM_EXECUTIONS_PER_SESSION) break;
      sessionExecutions.delete(expired.request.executionId);
    }
  }
  const next = new Map(executions);
  next.set(sessionId, sessionExecutions);
  return next;
}

function appendBoundedOutputs(
  projections: ReadonlyMap<string, ComputeOutputProjection>,
  key: string,
  appended: ReadonlyArray<ComputeOutput>,
): ReadonlyMap<string, ComputeOutputProjection> {
  const current = projections.get(key) ?? {
    outputs: [],
    bytes: 0,
    clipped: false,
    hasImage: false,
  };
  let outputs = [...current.outputs, ...appended];
  let bytes =
    current.bytes + appended.reduce((sum, output) => sum + computeOutputByteLength(output), 0);
  let clipped = current.clipped;
  while (
    outputs.length > 0 &&
    (outputs.length > MAXIMUM_LIVE_OUTPUT_ITEMS || bytes > MAXIMUM_LIVE_OUTPUT_BYTES)
  ) {
    const removed = outputs.shift();
    if (removed !== undefined) bytes -= computeOutputByteLength(removed);
    clipped = true;
  }
  const next = new Map(projections);
  next.delete(key);
  next.set(key, {
    outputs,
    bytes,
    clipped,
    hasImage: current.hasImage || appended.some((output) => output._tag === "image"),
  });
  while (next.size > MAXIMUM_LIVE_OUTPUT_PROJECTIONS) {
    const oldest = next.keys().next().value;
    if (oldest === undefined) break;
    next.delete(oldest);
  }
  return next;
}

function applyLiveEvent(
  state: ComputeSubscriptionState,
  event: Exclude<ComputeSessionStreamEvent, { readonly _tag: "session-snapshot" }>,
): ComputeSubscriptionState {
  switch (event._tag) {
    case "session-updated":
      return applySessionRecord(state, event.session);
    case "execution-updated":
      return {
        ...state,
        executions: setBoundedExecution(state.executions, event.sessionId, event.execution),
      };
    case "execution-output":
      return {
        ...state,
        outputs: appendBoundedOutputs(
          state.outputs,
          outputKey(event.sessionId, event.executionId),
          event.outputs,
        ),
      };
  }
}

/**
 * Folds the notification stream without pretending it is transcript authority.
 * A gap freezes delta application; the UI must re-read durable queries and
 * refresh this subscription, which begins again from a stamped snapshot.
 */
export function applyComputeSessionStreamEvent(
  state: ComputeSubscriptionState,
  event: ComputeSessionStreamEvent,
): ComputeSubscriptionState {
  if (event._tag === "session-snapshot") {
    if (state.stale) return state;
    if (state.snapshotBoundary !== null && state.snapshotBoundary !== event.eventSequence) {
      return {
        ...state,
        stale: true,
        observedGap: {
          expected: state.snapshotBoundary,
          received: event.eventSequence,
        },
      };
    }
    return {
      ...applySessionRecord(state, event.session),
      snapshotBoundary: event.eventSequence,
      expectedLiveSequence: state.expectedLiveSequence ?? event.eventSequence,
    };
  }

  if (state.stale) return state;
  // Empty projects have no snapshot; they still begin at cursor zero.
  const expected = state.expectedLiveSequence ?? state.snapshotBoundary ?? 0;
  if (event.eventSequence < expected) return state;
  if (event.eventSequence > expected) {
    return {
      ...state,
      stale: true,
      observedGap: { expected, received: event.eventSequence },
    };
  }
  return {
    ...applyLiveEvent(state, event),
    expectedLiveSequence: expected + 1,
  };
}

export function createComputeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
  settings?: (environmentId: EnvironmentId) => Atom.Atom<ScientificComputingSettings | undefined>,
) {
  const runtimeScheduler = createAtomCommandScheduler();
  const sessionScheduler = createAtomCommandScheduler();
  // Termination must not wait behind a restart it is intended to cancel.
  const stopScheduler = createAtomCommandScheduler();
  const executionScheduler = createAtomCommandScheduler();
  const sessionKey = ({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: { cwd: string; sessionId: string };
  }) => JSON.stringify([environmentId, input.cwd, input.sessionId]);

  const revision = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive),
  );
  const statusQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:compute:managed-runtime",
    tag: WS_METHODS.computeManagedRuntimeStatus,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  type StatusTarget = Parameters<typeof statusQuery>[0];
  const statusFamily = Atom.family((key: string) =>
    withManagedRuntimePolling(statusQuery(JSON.parse(key) as StatusTarget)),
  );
  const managedRuntime = (target: StatusTarget) => statusFamily(JSON.stringify(target));
  const inspection = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:compute:runtimes",
    tag: WS_METHODS.computeInspectRuntimes,
    staleTimeMs: 0,
    idleTtlMs: 0,
  });
  type InspectionTarget = Parameters<typeof inspection>[0];
  const runtimesFamily = Atom.family((key: string) => {
    const target = JSON.parse(key) as InspectionTarget;
    const status = managedRuntime({
      environmentId: target.environmentId,
      input: { languageId: ComputeLanguageId.make("python") },
    });
    const invalidation = Atom.make((get) =>
      JSON.stringify([
        get(revision(target.environmentId)),
        managedRuntimeInspectionKey(Option.getOrNull(AsyncResult.value(get(status)))),
        settings === undefined ? null : get(settings(target.environmentId)),
      ]),
    );
    const query = inspection(target).pipe(
      Atom.makeRefreshOnSignal(invalidation),
      Atom.setIdleTTL(0),
    );
    return Atom.transform(query, (get) => {
      // Wait for the first status snapshot, including after returning from another screen.
      // Unsupported/older hosts can still supply ordinary runtime discovery.
      if (get(status)._tag === "Initial") return AsyncResult.initial(true);
      return get(query);
    }).pipe(Atom.setIdleTTL(0));
  });
  const runtimes = (target: InspectionTarget) => runtimesFamily(JSON.stringify(target));

  // Settings keeps recent filesystem observations, never an execution-readiness
  // promise. Revalidation on mount and identity changes is cheap and process-free.
  const inventoryQuery = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:compute:runtime-inventory",
    tag: WS_METHODS.computeRuntimeInventory,
    staleTimeMs: 0,
    idleTtlMs: 60_000,
  });
  type InventoryTarget = Parameters<typeof inventoryQuery>[0];
  const inventoryFamily = Atom.family((key: string) => {
    const target = JSON.parse(key) as InventoryTarget;
    const invalidation = Atom.make((get) =>
      JSON.stringify([
        get(revision(target.environmentId)),
        settings === undefined ? null : get(settings(target.environmentId)),
      ]),
    );
    return withActiveOperationPolling(
      inventoryQuery(target).pipe(
        Atom.makeRefreshOnSignal(invalidation),
        Atom.swr({ staleTime: 0, revalidateOnMount: true }),
        Atom.setIdleTTL(0),
      ),
      (inventory) =>
        inventory.languages.some((language) => language.managedRuntime?.operation != null),
    );
  });
  const runtimeInventory = (target: InventoryTarget) => inventoryFamily(JSON.stringify(target));

  return {
    runtimeInventory,
    refreshRuntimeInventory: createEnvironmentCommand(runtime, {
      label: "environment-data:compute:refresh-runtime-inventory",
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }: InventoryTarget) => environmentId,
      },
      execute: (_input: InventoryTarget["input"], registry, environmentId) =>
        Effect.gen(function* () {
          const query = runtimeInventory({ environmentId, input: {} });
          registry.refresh(query);
          return yield* AtomRegistry.getResult(registry, query, { suspendOnWaiting: true });
        }),
    }),
    runtimes,
    refreshRuntimes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:refresh-runtimes",
      tag: WS_METHODS.computeInspectRuntimes,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
      onSuccess: ({ environmentId }, registry) =>
        Effect.sync(() => {
          registry.refresh(
            managedRuntime({
              environmentId,
              input: { languageId: ComputeLanguageId.make("python") },
            }),
          );
          registry.update(revision(environmentId), (value) => value + 1);
        }),
    }),
    managedRuntime,
    manageRuntime: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:manage-runtime",
      tag: WS_METHODS.computeManageRuntime,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.languageId]),
      },
      onSettled: (target, registry) =>
        Effect.sync(() => {
          registry.refresh(
            managedRuntime({ ...target, input: { languageId: target.input.languageId } }),
          );
          registry.update(revision(target.environmentId), (value) => value + 1);
        }),
    }),
    cancelManagedRuntime: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:cancel-managed-runtime",
      tag: WS_METHODS.computeCancelManagedRuntime,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.languageId]),
      },
      onSettled: (target, registry) =>
        Effect.sync(() =>
          registry.refresh(
            managedRuntime({ ...target, input: { languageId: target.input.languageId } }),
          ),
        ),
    }),
    sessions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:compute:sessions",
      tag: WS_METHODS.computeListSessions,
      staleTimeMs: 0,
    }),
    session: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:compute:session",
      tag: WS_METHODS.computeGetSession,
      staleTimeMs: 0,
      idleTtlMs: 60_000,
    }),
    executions: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:compute:executions",
      tag: WS_METHODS.computeListExecutions,
      staleTimeMs: 0,
      idleTtlMs: 60_000,
    }),
    outputs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:compute:outputs",
      tag: WS_METHODS.computeListOutputs,
      staleTimeMs: 0,
      idleTtlMs: 60_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:compute:events",
      tag: WS_METHODS.subscribeComputeSessions,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_COMPUTE_SUBSCRIPTION_STATE, applyComputeSessionStreamEvent)),
    }),
    verifyRuntime: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:verify-runtime",
      tag: WS_METHODS.computeVerifyRuntime,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.languageId, input.executable]),
      },
    }),
    startSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:start-session",
      tag: WS_METHODS.computeStartSession,
      scheduler: sessionScheduler,
      concurrency: { mode: "singleFlight", key: sessionKey },
    }),
    restartSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:restart-session",
      tag: WS_METHODS.computeRestartSession,
      scheduler: sessionScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
    stopSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:stop-session",
      tag: WS_METHODS.computeStopSession,
      scheduler: stopScheduler,
      concurrency: { mode: "singleFlight", key: sessionKey },
    }),
    interruptSession: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:interrupt-session",
      tag: WS_METHODS.computeInterruptSession,
      scheduler: sessionScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
    inspectVariables: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:inspect-variables",
      tag: WS_METHODS.computeInspectVariables,
      scheduler: sessionScheduler,
      concurrency: { mode: "singleFlight", key: sessionKey },
    }),
    submitExecution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:submit-execution",
      tag: WS_METHODS.computeSubmitExecution,
      scheduler: executionScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
    cancelExecution: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:cancel-execution",
      tag: WS_METHODS.computeCancelExecution,
      scheduler: executionScheduler,
      concurrency: { mode: "serial", key: sessionKey },
    }),
  };
}
