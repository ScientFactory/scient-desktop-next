import {
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  WS_METHODS,
  computeOutputByteLength,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeSessionRecord,
  type ComputeSessionStreamEvent,
} from "@t3tools/contracts";
import * as Stream from "effect/Stream";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

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
  const expected = state.expectedLiveSequence ?? state.snapshotBoundary ?? event.eventSequence;
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
) {
  const runtimeScheduler = createAtomCommandScheduler();
  const sessionScheduler = createAtomCommandScheduler();
  const executionScheduler = createAtomCommandScheduler();
  const sessionKey = ({
    environmentId,
    input,
  }: {
    environmentId: string;
    input: { cwd: string; sessionId: string };
  }) => JSON.stringify([environmentId, input.cwd, input.sessionId]);

  return {
    runtimes: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:compute:runtimes",
      tag: WS_METHODS.computeInspectRuntimes,
      staleTimeMs: 15_000,
    }),
    refreshRuntimes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:compute:refresh-runtimes",
      tag: WS_METHODS.computeInspectRuntimes,
      scheduler: runtimeScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => JSON.stringify([environmentId, input.cwd]),
      },
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
      scheduler: sessionScheduler,
      concurrency: { mode: "serial", key: sessionKey },
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
