// @effect-diagnostics nodeBuiltinImport:off -- submitted code is hashed with host SHA-256.
import * as NodeCrypto from "node:crypto";

import {
  ComputeExecutionId,
  ComputeOperationError,
  ComputeRequestId,
  EMPTY_COMPUTE_QUEUE,
  EMPTY_COMPUTE_SESSION_STORAGE,
  INITIAL_COMPUTE_SESSION_GENERATION,
  REQUIRED_COMPUTE_CAPABILITIES,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
  admitComputeExecution,
  cancelComputeExecution,
  checkComputeSessionGeneration,
  computeOutputByteLength,
  computeQueueEntries,
  drainComputeQueue,
  finishComputeExecution,
  missingComputeCapabilities,
  nextComputeSessionGeneration,
  startNextComputeExecution,
  transitionComputeExecutionStatus,
  transitionComputeSessionStatus,
  type ComputeChannel,
  type ComputeDiagnostic,
  type ComputeExecutionCommandInput,
  type ComputeExecutionOutputs,
  type ComputeExecutionRecord,
  type ComputeExecutionRequestRecord,
  type ComputeExecutionResultRecord,
  type ComputeExecutionStatus,
  type ComputeGetSessionInput,
  type ComputeInterruptOutcome,
  type ComputeLanguageAdapter,
  type ComputeListExecutionsInput,
  type ComputeListOutputsInput,
  type ComputeListSessionsInput,
  type ComputeOutput,
  type ComputeOutputResourceRef,
  type ComputeProjectId,
  type ComputeQueueState,
  type ComputeSessionCommandInput,
  type ComputeSessionGeneration,
  type ComputeSessionId,
  type ComputeSessionJournalEntry,
  type ComputeSessionJournalEvent,
  type ComputeSessionRecord,
  type ComputeSessionStatus,
  type ComputeSessionStorage,
  type ComputeSessionStreamEvent,
  type ComputeStartSessionInput,
  type ComputeSubmitExecutionInput,
  type ComputeSubscribeSessionsInput,
  type ComputeTransport,
  type ComputeTransportEvent,
} from "@scientfactory/compute";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { sanitizeComputeEnvironment, validateProjectRoot } from "./ComputeEnvironmentPolicy.ts";
import * as LocalComputeStore from "./LocalComputeStore.ts";
import type { ResolvedComputeOutputImage } from "./LocalComputeStore.ts";

/**
 * One coordinator for every live compute session.
 *
 * A transport speaks to one runtime and knows nothing else; a store knows what
 * happened and nothing about what is happening. This is the only place that
 * holds both, and everything it does follows from two rules.
 *
 * The first is that the store is told before anyone else. Every status change,
 * every request, every line of output is durable before it is published, so a
 * client can never have been told something the disk does not know. The one
 * deliberate exception is a queue position, which is a view of the queue as it
 * is right now rather than something that happened, and is documented where it
 * is derived.
 *
 * The second is that a generation is a namespace. A session that restarts is a
 * new namespace with the same name, and every mutating command carries the
 * generation the caller believed it was addressing. A command for a generation
 * that has been replaced is refused rather than applied to the namespace that
 * replaced it, because running a user's code in the wrong namespace is worse
 * than telling them their view is stale.
 *
 * Nothing is ever replayed. Code that was in flight when the server stopped is
 * recorded as lost and code that was still queued is recorded as cancelled,
 * because re-running what a user did not ask for again is worse than telling
 * them it did not run.
 */

/** How long the idle sweep waits between passes, however short the timeout is. */
const IDLE_SWEEP_MINIMUM_MS = 1_000;

const SERVER_RESTART_REASON = "The server restarted while this session was running.";
const TRANSPORT_CLOSED_REASON = "The runtime stopped without saying why.";
const TRANSPORT_FAILED_REASON = "The connection to the runtime failed.";
const RESTART_DETAIL = "The session was restarted before this ran.";
const STOP_DETAIL = "The session was stopped before this ran.";
const INTERRUPT_TIMEOUT_DETAIL = "The runtime did not answer an interrupt.";

/** A language and the transport that can carry it, paired at wiring time. */
export interface ComputeRuntimeBinding {
  readonly adapter: ComputeLanguageAdapter;
  readonly transport: ComputeTransport;
}

/**
 * Retention and lifetime limits, injected so a test can reach them.
 *
 * `idleTimeoutMs` is null by default on purpose: a namespace a user built up
 * over an afternoon is not something to reclaim behind their back, and the
 * decision to trade it for memory belongs to whoever configures the server.
 *
 * The two output ceilings bound what a session can write to disk. They are
 * separate because a runaway loop inside one execution is a different failure
 * from a session that has been chatting to itself for a week, and a client
 * needs to be told which one it is looking at.
 */
export interface ComputeSessionServiceOptions {
  readonly idleTimeoutMs: number | null;
  readonly maximumExecutionOutputBytes: number;
  readonly maximumSessionOutputBytes: number;
}

export const DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS: ComputeSessionServiceOptions = {
  idleTimeoutMs: null,
  maximumExecutionOutputBytes: 8 * 1024 * 1024,
  maximumSessionOutputBytes: 32 * 1024 * 1024,
};

type ComputeOperation = ComputeOperationError["operation"];
type ComputeReason = ComputeOperationError["reason"];

function computeError(
  operation: ComputeOperation,
  reason: ComputeReason,
  message: string,
  cause?: unknown,
): ComputeOperationError {
  return new ComputeOperationError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Durable text fields are bounded by their schemas; clamp before encoding. */
function shortText(value: string): string {
  return value.slice(0, 4096);
}

function labelText(value: string): string {
  return value.slice(0, 256);
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

function codeHash(code: string): string {
  return `sha256:${NodeCrypto.createHash("sha256").update(code, "utf8").digest("hex")}`;
}

function eventProjectId(event: ComputeSessionStreamEvent): ComputeProjectId {
  return event._tag === "session-snapshot" || event._tag === "session-updated"
    ? event.session.projectId
    : event.projectId;
}

/** How much of a transcript is already spent, and what it is allowed to spend. */
interface OutputBudget {
  readonly bytes: number;
  readonly truncated: boolean;
  readonly ceiling: number;
}

/**
 * Both ceilings an output has to fit under.
 *
 * `execution` is null for output the runtime attributed to no request. The
 * session ceiling always applies, because a transcript that grows by a modest
 * amount per execution grows without bound otherwise.
 */
interface OutputBudgets {
  readonly session: OutputBudget;
  readonly execution: OutputBudget | null;
}

/** Which transcripts a loss of output has to be reported against. */
interface TruncatedScopes {
  readonly session: boolean;
  readonly execution: boolean;
}

interface ComputeDispatch {
  readonly executionId: ComputeExecutionId;
  readonly generation: ComputeSessionGeneration;
  readonly code: string;
}

interface InterruptTarget {
  readonly executionId: ComputeExecutionId;
  readonly generation: ComputeSessionGeneration;
}

/**
 * A session this process is holding open.
 *
 * `pendingRef` holds only the executions that have not reached a terminal
 * status. History is read from the store, so a session that has been worked in
 * all day costs the memory of its queue rather than the memory of everything it
 * has ever run.
 *
 * `mutation` is what makes the event drain and the commands agree: both take it
 * before touching any of these refs, and neither holds it across a call to the
 * transport, so a slow interrupt cannot stall the output it is trying to stop.
 */
interface LiveComputeSession {
  readonly projectId: ComputeProjectId;
  readonly sessionId: ComputeSessionId;
  readonly adapter: ComputeLanguageAdapter;
  readonly scope: Scope.Closeable;
  readonly channel: ComputeChannel;
  readonly mutation: Semaphore.Semaphore;
  readonly recordRef: Ref.Ref<ComputeSessionRecord>;
  readonly queueRef: Ref.Ref<ComputeQueueState>;
  readonly pendingRef: Ref.Ref<ReadonlyMap<ComputeExecutionId, ComputeExecutionRecord>>;
  readonly readyRef: Ref.Ref<Deferred.Deferred<ComputeSessionRecord, ComputeOperationError> | null>;
  readonly journalRef: Ref.Ref<number>;
  readonly sessionOutputRef: Ref.Ref<{ readonly bytes: number; readonly truncated: boolean }>;
}

export class ComputeSessionService extends Context.Service<
  ComputeSessionService,
  {
    readonly startSession: (
      input: ComputeStartSessionInput,
    ) => Effect.Effect<ComputeSessionRecord, ComputeOperationError>;
    readonly submitExecution: (
      input: ComputeSubmitExecutionInput,
    ) => Effect.Effect<ComputeExecutionRecord, ComputeOperationError>;
    readonly cancelExecution: (
      input: ComputeExecutionCommandInput,
    ) => Effect.Effect<ComputeExecutionRecord, ComputeOperationError>;
    readonly interruptSession: (
      input: ComputeSessionCommandInput,
    ) => Effect.Effect<ComputeSessionRecord, ComputeOperationError>;
    readonly restartSession: (
      input: ComputeSessionCommandInput,
    ) => Effect.Effect<ComputeSessionRecord, ComputeOperationError>;
    readonly stopSession: (
      input: ComputeSessionCommandInput,
    ) => Effect.Effect<ComputeSessionRecord, ComputeOperationError>;
    readonly listSessions: (
      input: ComputeListSessionsInput,
    ) => Effect.Effect<ReadonlyArray<ComputeSessionRecord>, ComputeOperationError>;
    readonly getSession: (
      input: ComputeGetSessionInput,
    ) => Effect.Effect<ComputeSessionRecord | null, ComputeOperationError>;
    readonly listExecutions: (
      input: ComputeListExecutionsInput,
    ) => Effect.Effect<ReadonlyArray<ComputeExecutionRecord>, ComputeOperationError>;
    readonly listOutputs: (
      input: ComputeListOutputsInput,
    ) => Effect.Effect<ComputeExecutionOutputs, ComputeOperationError>;
    readonly listJournal: (
      input: ComputeGetSessionInput,
    ) => Effect.Effect<ReadonlyArray<ComputeSessionJournalEntry>, ComputeOperationError>;
    readonly resolveOutputImage: (
      ref: ComputeOutputResourceRef,
    ) => Effect.Effect<ResolvedComputeOutputImage | null, ComputeOperationError>;
    readonly subscribeSessions: (
      input: ComputeSubscribeSessionsInput,
    ) => Effect.Effect<
      Stream.Stream<ComputeSessionStreamEvent>,
      ComputeOperationError,
      Scope.Scope
    >;
  }
>()("t3/scient/compute/ComputeSessionService") {}

/**
 * Empty by default: a server with no compute runtime wired in refuses to start
 * a session with a message naming the language, rather than pretending it could
 * have run it.
 */
class ComputeRuntimeBindings extends Context.Reference<ReadonlyArray<ComputeRuntimeBinding>>(
  "t3/scient/compute/ComputeRuntimeBindings",
  { defaultValue: (): ReadonlyArray<ComputeRuntimeBinding> => [] },
) {}

class ComputeSessionServiceConfig extends Context.Reference<ComputeSessionServiceOptions>(
  "t3/scient/compute/ComputeSessionServiceOptions",
  { defaultValue: () => DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS },
) {}

const make = Effect.gen(function* () {
  const bindings = yield* ComputeRuntimeBindings;
  const options = yield* ComputeSessionServiceConfig;
  const hostEnvironment = yield* HostProcessEnvironment;
  const store = yield* LocalComputeStore.LocalComputeStore;
  const serviceScope = yield* Scope.make("sequential");
  const startLock = yield* Semaphore.make(1);
  const recoveryLock = yield* Semaphore.make(1);
  const sessionsRef = yield* Ref.make(new Map<string, LiveComputeSession>());
  const recoveredProjectsRef = yield* Ref.make(new Set<string>());
  const eventSequenceRef = yield* Ref.make(0);
  // A slow or abandoned client must neither stop a kernel drain nor consume
  // unbounded server memory. The stream is therefore a bounded notification
  // channel, while the store remains the transcript authority. Event sequence
  // gaps tell Phase 4 clients to re-read sessions/executions/output before
  // continuing; no scientific result depends on retaining a socket backlog.
  const pubsub = yield* PubSub.sliding<ComputeSessionStreamEvent>(512);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const nextEventSequence = Ref.getAndUpdate(eventSequenceRef, (value) => value + 1);
  const sessionKey = (projectId: ComputeProjectId, sessionId: ComputeSessionId): string =>
    `${projectId}/${sessionId}`;

  // -------------------------------------------------------------------------
  // Publishing and persistence
  // -------------------------------------------------------------------------

  const publishSession = (session: ComputeSessionRecord) =>
    Effect.gen(function* () {
      const eventSequence = yield* nextEventSequence;
      yield* PubSub.publish(pubsub, { _tag: "session-updated" as const, eventSequence, session });
    });

  const publishExecution = (live: LiveComputeSession, execution: ComputeExecutionRecord) =>
    Effect.gen(function* () {
      const eventSequence = yield* nextEventSequence;
      yield* PubSub.publish(pubsub, {
        _tag: "execution-updated" as const,
        eventSequence,
        projectId: live.projectId,
        sessionId: live.sessionId,
        execution,
      });
    });

  const publishOutputs = (
    live: LiveComputeSession,
    executionId: ComputeExecutionId | null,
    outputs: ReadonlyArray<ComputeOutput>,
  ) =>
    Effect.gen(function* () {
      const eventSequence = yield* nextEventSequence;
      yield* PubSub.publish(pubsub, {
        _tag: "execution-output" as const,
        eventSequence,
        projectId: live.projectId,
        sessionId: live.sessionId,
        executionId,
        outputs,
      });
    });

  const persistenceError = (operation: ComputeOperation, message: string) => (cause: unknown) =>
    computeError(operation, "persistence-failed", message, cause);

  const persistSession = (operation: ComputeOperation, record: ComputeSessionRecord) =>
    store
      .writeSession(record)
      .pipe(Effect.mapError(persistenceError(operation, "Unable to record the compute session.")));

  const persistResult = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    result: ComputeExecutionResultRecord,
  ) =>
    store
      .writeExecutionResult(live.projectId, live.sessionId, result)
      .pipe(Effect.mapError(persistenceError(operation, "Unable to record the execution result.")));

  const appendJournal = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    event: ComputeSessionJournalEvent,
    detail: string | null,
    executionId: ComputeExecutionId | null,
  ) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      const sequence = yield* Ref.getAndUpdate(live.journalRef, (value) => value + 1);
      const observedAt = yield* nowIso;
      yield* store
        .appendJournal(live.projectId, live.sessionId, {
          sequence,
          observedAt,
          event,
          generation: record.generation,
          executionId,
          detail: detail === null ? null : shortText(detail),
        })
        .pipe(
          Effect.mapError(persistenceError(operation, "Unable to record what the session did.")),
        );
    });

  const measureStorage = (live: LiveComputeSession, fallback: ComputeSessionStorage) =>
    store.measureSessionStorage(live.projectId, live.sessionId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("compute session storage could not be measured", {
          projectId: live.projectId,
          sessionId: live.sessionId,
          operation: cause.operation,
        }),
      ),
      Effect.orElseSucceed(() => fallback),
    );

  // -------------------------------------------------------------------------
  // State transitions, all taken with the session lease held
  // -------------------------------------------------------------------------

  const setSessionStatus = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    next: ComputeSessionStatus,
    change: (record: ComputeSessionRecord) => ComputeSessionRecord = (record) => record,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(live.recordRef);
      const status = yield* transitionComputeSessionStatus(current.status, next).pipe(
        Effect.mapError((cause) =>
          computeError(operation, "session-terminal", cause.message, cause),
        ),
      );
      const lastActivityAt = yield* nowIso;
      const record = change({ ...current, status, lastActivityAt });
      yield* persistSession(operation, record);
      yield* Ref.set(live.recordRef, record);
      yield* publishSession(record);
      return record;
    });

  /**
   * Moves one execution to a new status, or leaves it alone.
   *
   * A report about an execution that has already ended, or about one this
   * process is no longer holding, is normal rather than exceptional: a
   * transport settles what was in flight after a stop has already recorded it.
   * Such a report is logged and dropped instead of being forced through.
   */
  const setExecutionStatus = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    executionId: ComputeExecutionId,
    next: ComputeExecutionStatus,
    change: (result: ComputeExecutionResultRecord) => ComputeExecutionResultRecord = (result) =>
      result,
  ) =>
    Effect.gen(function* () {
      const existing = (yield* Ref.get(live.pendingRef)).get(executionId);
      if (existing === undefined || existing.result === null) return null;
      const status = yield* transitionComputeExecutionStatus(existing.result.status, next).pipe(
        Effect.tapError((cause) =>
          Effect.logDebug("compute execution report ignored", {
            projectId: live.projectId,
            sessionId: live.sessionId,
            executionId,
            message: cause.message,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (status === null) return null;
      const observedAt = yield* nowIso;
      const terminal = TERMINAL_COMPUTE_EXECUTION_STATUSES.has(status);
      const result = change({
        ...existing.result,
        status,
        outcome:
          status === "succeeded" || status === "failed" || status === "cancelled"
            ? status
            : existing.result.outcome,
        queuePosition: status === "queued" ? existing.result.queuePosition : null,
        startedAt:
          status === "running" && existing.result.startedAt === null
            ? observedAt
            : existing.result.startedAt,
        finishedAt: terminal ? observedAt : existing.result.finishedAt,
      });
      const execution: ComputeExecutionRecord = { request: existing.request, result };
      yield* persistResult(operation, live, result);
      yield* Ref.update(live.pendingRef, (map) => {
        const updated = new Map(map);
        if (terminal) updated.delete(executionId);
        else updated.set(executionId, execution);
        return updated;
      });
      yield* publishExecution(live, execution);
      return execution;
    });

  /**
   * Re-derives queue positions in memory after the queue moves.
   *
   * Deliberately not persisted: a position is a view of the queue as it is right
   * now rather than something that happened, and it is null on disk for every
   * execution that survives a restart anyway. Rewriting N result files because
   * one execution was cancelled would buy nothing.
   */
  const republishQueuePositions = (live: LiveComputeSession) =>
    Effect.gen(function* () {
      const queue = yield* Ref.get(live.queueRef);
      const positions = new Map(
        computeQueueEntries(queue).map((entry) => [entry.executionId, entry.position] as const),
      );
      const pending = yield* Ref.get(live.pendingRef);
      const updated = new Map(pending);
      const changed: Array<ComputeExecutionRecord> = [];
      for (const [executionId, execution] of pending) {
        if (execution.result === null || execution.result.status !== "queued") continue;
        const position = positions.get(executionId) ?? null;
        if (execution.result.queuePosition === position) continue;
        const next: ComputeExecutionRecord = {
          request: execution.request,
          result: { ...execution.result, queuePosition: position },
        };
        updated.set(executionId, next);
        changed.push(next);
      }
      if (changed.length === 0) return;
      yield* Ref.set(live.pendingRef, updated);
      yield* Effect.forEach(changed, (execution) => publishExecution(live, execution), {
        discard: true,
      });
    });

  /** Brings the session record back in line with the queue after it moves. */
  const syncQueueCounters = (operation: ComputeOperation, live: LiveComputeSession) =>
    Effect.gen(function* () {
      const queue = yield* Ref.get(live.queueRef);
      const current = yield* Ref.get(live.recordRef);
      const lastActivityAt = yield* nowIso;
      const record: ComputeSessionRecord = {
        ...current,
        activity: queue.active === null ? "idle" : "busy",
        activeExecutionId: queue.active,
        pendingCount: queue.pending.length,
        lastActivityAt,
      };
      yield* persistSession(operation, record);
      yield* Ref.set(live.recordRef, record);
      yield* publishSession(record);
      yield* republishQueuePositions(live);
      return record;
    });

  const completePendingReady = (live: LiveComputeSession, record: ComputeSessionRecord) =>
    Effect.gen(function* () {
      const ready = yield* Ref.getAndSet(live.readyRef, null);
      if (ready !== null) yield* Deferred.succeed(ready, record);
    });

  const failPendingReady = (live: LiveComputeSession, error: ComputeOperationError) =>
    Effect.gen(function* () {
      const ready = yield* Ref.getAndSet(live.readyRef, null);
      if (ready !== null) yield* Deferred.fail(ready, error);
    });

  // -------------------------------------------------------------------------
  // Output
  // -------------------------------------------------------------------------

  const appendOutputs = (
    live: LiveComputeSession,
    executionId: ComputeExecutionId | null,
    outputs: ReadonlyArray<ComputeOutput>,
  ) =>
    store
      .appendOutputs({
        projectId: live.projectId,
        sessionId: live.sessionId,
        executionId,
        outputs,
      })
      .pipe(Effect.mapError(persistenceError("outputs", "Unable to record compute output.")));

  const readBudgets = (live: LiveComputeSession, executionId: ComputeExecutionId | null) =>
    Effect.gen(function* () {
      const spent = yield* Ref.get(live.sessionOutputRef);
      const session: OutputBudget = {
        bytes: spent.bytes,
        truncated: spent.truncated,
        ceiling: options.maximumSessionOutputBytes,
      };
      if (executionId === null) return { session, execution: null } satisfies OutputBudgets;
      const execution =
        (yield* Ref.get(live.pendingRef)).get(executionId) ??
        (yield* store
          .loadExecution(live.projectId, live.sessionId, executionId)
          .pipe(Effect.mapError(persistenceError("outputs", "Unable to read output ownership."))));
      if (execution === null || execution === undefined || execution.result === null) return null;
      return {
        session,
        execution: {
          bytes: execution.result.outputBytes,
          truncated: execution.result.truncated,
          ceiling: options.maximumExecutionOutputBytes,
        },
      } satisfies OutputBudgets;
    });

  const chargeSessionOutput = (live: LiveComputeSession, bytes: number, truncated: boolean) =>
    Ref.update(live.sessionOutputRef, (session) => ({
      bytes: session.bytes + bytes,
      truncated: session.truncated || truncated,
    }));

  /**
   * Charges recorded output against a budget.
   *
   * An execution's counters are kept in memory and written out when its status
   * changes, not on every line: `output.ndjson` is append-only and is the
   * durable truth, while `result.json` is atomically replaced, and replacing a
   * file per line of a loop that prints ten thousand of them would make a
   * session unusable. Recovery recounts from the transcript for the executions
   * that were in flight, which is the only case where the counters could be
   * behind.
   */
  const chargeBudget = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    executionId: ComputeExecutionId | null,
    bytes: number,
    count: number,
    truncated: TruncatedScopes,
  ) =>
    Effect.gen(function* () {
      // Every byte kept counts against the session, whether or not an execution
      // claimed it. The session's counter is the only one that spans them.
      yield* chargeSessionOutput(live, bytes, truncated.session);
      if (executionId === null) return;
      const pending = yield* Ref.get(live.pendingRef);
      const wasPending = pending.has(executionId);
      const existing =
        pending.get(executionId) ??
        (yield* store
          .loadExecution(live.projectId, live.sessionId, executionId)
          .pipe(Effect.mapError(persistenceError(operation, "Unable to read output ownership."))));
      if (existing === null || existing === undefined || existing.result === null) return;
      const result: ComputeExecutionResultRecord = {
        ...existing.result,
        outputCount: existing.result.outputCount + count,
        outputBytes: existing.result.outputBytes + bytes,
        truncated: existing.result.truncated || truncated.execution,
      };
      if (wasPending) {
        yield* Ref.update(live.pendingRef, (map) =>
          new Map(map).set(executionId, { request: existing.request, result }),
        );
      }
      // Saying the transcript is incomplete is worth a write of its own; the
      // counters alone are not, and ride along with the next status change.
      if (!wasPending || (truncated.execution && !existing.result.truncated)) {
        yield* persistResult(operation, live, result);
        yield* publishExecution(live, { request: existing.request, result });
      }
    });

  /**
   * Stands in for the output that would have crossed a ceiling.
   *
   * It takes that output's own sequence, because exactly one product belongs at
   * that position in the transcript and this is now what it is. Everything
   * after it in the same execution is dropped without another marker: one
   * honest statement that the transcript is incomplete is what a reader needs.
   */
  const truncationMarker = (
    output: ComputeOutput,
    scope: "execution" | "session",
    ceiling: number,
  ): ComputeOutput => ({
    _tag: "system",
    sequence: output.sequence,
    observedAt: output.observedAt,
    event: "output-truncated",
    detail: shortText(
      scope === "execution"
        ? `Output stopped being kept after ${ceiling} bytes. The execution carried on; the rest of its output was not retained.`
        : `This session stopped keeping output after ${ceiling} bytes in total. The code carried on; nothing further was retained.`,
    ),
  });

  const applyOutput = (
    live: LiveComputeSession,
    event: Extract<ComputeTransportEvent, { readonly _tag: "output" }>,
  ) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      // Output minted by a namespace that has been replaced belongs to nothing
      // a client is looking at.
      if (event.generation !== record.generation) return false;
      const executionId =
        event.requestId === null ? null : ComputeExecutionId.make(event.requestId);
      const budgets = yield* readBudgets(live, executionId);
      if (budgets === null) return false;
      // A transcript that has already said it is incomplete says it once;
      // everything after the marker is dropped in silence.
      if (budgets.session.truncated || budgets.execution?.truncated === true) return false;
      const size = computeOutputByteLength(event.output);
      const crossed =
        budgets.execution !== null && budgets.execution.bytes + size > budgets.execution.ceiling
          ? { scope: "execution" as const, ceiling: budgets.execution.ceiling }
          : budgets.session.bytes + size > budgets.session.ceiling
            ? { scope: "session" as const, ceiling: budgets.session.ceiling }
            : null;
      if (crossed !== null) {
        const marker = truncationMarker(event.output, crossed.scope, crossed.ceiling);
        yield* appendOutputs(live, executionId, [marker]);
        // A full session has also cut this execution's transcript short, so
        // both are marked. A full execution has not filled the session.
        yield* chargeBudget("outputs", live, executionId, computeOutputByteLength(marker), 1, {
          execution: true,
          session: crossed.scope === "session",
        });
        yield* publishOutputs(live, executionId, [marker]);
        return false;
      }
      // Image bytes are stored before the line that names them, so a transcript
      // never points at bytes that are not there. Bytes the store refuses are
      // the same kind of loss as a ceiling and are marked the same way -- and so
      // is an image that arrives carrying no bytes at all. That last one is a
      // transport breaking its own contract rather than a runtime producing more
      // than we keep, but it costs a reader the same thing, a transcript line
      // pointing at an image nobody can open, so it is refused the same way
      // instead of trusted because it came from inside the process.
      if (event.output._tag === "image") {
        const carried = event.image;
        if (carried === null) {
          yield* Effect.logWarning("compute output image arrived without bytes", {
            projectId: live.projectId,
            sessionId: live.sessionId,
            executionId,
            contentHash: event.output.contentHash,
          });
          const scope = budgets.execution === null ? "session" : "execution";
          const ceiling =
            budgets.execution === null ? budgets.session.ceiling : budgets.execution.ceiling;
          const marker = truncationMarker(event.output, scope, ceiling);
          yield* appendOutputs(live, executionId, [marker]);
          yield* chargeBudget("outputs", live, executionId, computeOutputByteLength(marker), 1, {
            execution: executionId !== null,
            session: executionId === null,
          });
          yield* publishOutputs(live, executionId, [marker]);
          return false;
        }
        yield* store
          .writeOutputImage({
            projectId: live.projectId,
            sessionId: live.sessionId,
            executionId,
            contentHash: event.output.contentHash,
            bytes: carried.bytes,
          })
          .pipe(Effect.mapError(persistenceError("outputs", "Unable to record an output image.")));
      }
      yield* appendOutputs(live, executionId, [event.output]);
      yield* chargeBudget("outputs", live, executionId, size, 1, {
        execution: false,
        session: false,
      });
      yield* publishOutputs(live, executionId, [event.output]);
      return true;
    });

  const recordDiagnostics = (
    live: LiveComputeSession,
    executionId: ComputeExecutionId,
    diagnostics: ReadonlyArray<ComputeDiagnostic>,
  ) =>
    Effect.gen(function* () {
      const pending = yield* Ref.get(live.pendingRef);
      const wasPending = pending.has(executionId);
      const existing =
        pending.get(executionId) ??
        (yield* store
          .loadExecution(live.projectId, live.sessionId, executionId)
          .pipe(
            Effect.mapError(persistenceError("outputs", "Unable to read diagnostic ownership.")),
          ));
      if (existing === null || existing === undefined || existing.result === null) return;
      const first = diagnostics[0];
      const result: ComputeExecutionResultRecord = {
        ...existing.result,
        // Bounded by the schema at 64: the first errors are the ones that
        // explain the failure, and a runtime that reports thousands is telling
        // a client nothing more.
        diagnostics: [...existing.result.diagnostics, ...diagnostics].slice(0, 64),
        failureReason:
          existing.result.failureReason ??
          (first === undefined ? null : shortText(`${first.errorName}: ${first.message}`)),
      };
      if (wasPending) {
        yield* Ref.update(live.pendingRef, (map) =>
          new Map(map).set(executionId, { request: existing.request, result }),
        );
      }
      yield* persistResult("outputs", live, result);
      yield* publishExecution(live, { request: existing.request, result });
    });

  // -------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------

  /** Moves the queue forward under the session lease and says what to send. */
  const takeNextDispatch = (operation: ComputeOperation, live: LiveComputeSession) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      // A session that is still starting may hold a queue -- a user is allowed
      // to type ahead of a kernel -- but nothing is sent until it is ready.
      if (record.status !== "ready") return null;
      const queue = yield* Ref.get(live.queueRef);
      const advanced = startNextComputeExecution(queue);
      if (advanced.started === null) return null;
      const execution = (yield* Ref.get(live.pendingRef)).get(advanced.started);
      if (execution === undefined || execution.result === null) {
        yield* Ref.set(live.queueRef, finishComputeExecution(advanced.state, advanced.started));
        return null;
      }
      yield* Ref.set(live.queueRef, advanced.state);
      yield* setExecutionStatus(operation, live, advanced.started, "submitting");
      yield* syncQueueCounters(operation, live);
      return {
        executionId: advanced.started,
        generation: record.generation,
        code: execution.request.code,
      } satisfies ComputeDispatch;
    });

  const failDispatch = (
    live: LiveComputeSession,
    executionId: ComputeExecutionId,
    message: string,
  ) =>
    Effect.gen(function* () {
      yield* setExecutionStatus("submit", live, executionId, "failed", (result) => ({
        ...result,
        failureReason: shortText(message),
      }));
      yield* Ref.update(live.queueRef, (queue) => finishComputeExecution(queue, executionId));
      yield* syncQueueCounters("submit", live);
    });

  /** Sends what `takeNextDispatch` chose, with the session lease released. */
  const dispatch = (live: LiveComputeSession, next: ComputeDispatch | null) =>
    next === null
      ? Effect.void
      : live.channel
          .execute({
            requestId: ComputeRequestId.make(next.executionId),
            expectedGeneration: next.generation,
            code: next.code,
          })
          .pipe(
            Effect.catch((cause) =>
              live.mutation.withPermits(1)(failDispatch(live, next.executionId, cause.message)),
            ),
          );

  const advanceQueue = (operation: ComputeOperation, live: LiveComputeSession) =>
    live.mutation
      .withPermits(1)(takeNextDispatch(operation, live))
      .pipe(Effect.flatMap((next) => dispatch(live, next)));

  /**
   * Empties the queue. Whatever was running ends as `activeStatus`; everything
   * waiting is cancelled, because it never reached the runtime at all.
   */
  const cancelEverything = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    reason: string,
    activeStatus: "lost" | "cancelled",
  ) =>
    Effect.gen(function* () {
      const drained = drainComputeQueue(yield* Ref.get(live.queueRef));
      yield* Ref.set(live.queueRef, drained.state);
      if (drained.active !== null) {
        yield* setExecutionStatus(operation, live, drained.active, activeStatus, (result) => ({
          ...result,
          failureReason: result.failureReason ?? shortText(reason),
        }));
      }
      for (const executionId of drained.cancelled) {
        yield* setExecutionStatus(operation, live, executionId, "cancelled");
        yield* appendJournal(operation, live, "execution-cancelled", reason, executionId);
      }
    });

  // -------------------------------------------------------------------------
  // Loss and retirement
  // -------------------------------------------------------------------------

  /**
   * Closes the book on a session, exactly once.
   *
   * A session that ends while a stop is in flight has stopped, whatever the
   * runtime's parting words were: the user asked for this and it happened. A
   * session that ends any other way is lost, and says why. Both routes arrive
   * here -- a `lost` event, a transport failure, the event stream simply ending,
   * and the stop command itself -- so the first one to take the lease decides
   * and the rest find a terminal record and leave it alone.
   */
  const endSession = (live: LiveComputeSession, reason: string) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(live.recordRef);
      if (TERMINAL_COMPUTE_SESSION_STATUSES.has(current.status)) return current;
      const stopping = current.status === "stopping";
      yield* cancelEverything("stop", live, reason, stopping ? "cancelled" : "lost");
      const settled = yield* Ref.get(live.recordRef);
      const storage = yield* measureStorage(live, settled.storage);
      const observedAt = yield* nowIso;
      const status = yield* transitionComputeSessionStatus(
        settled.status,
        stopping ? "stopped" : "lost",
      ).pipe(Effect.orDie);
      const record: ComputeSessionRecord = {
        ...settled,
        status,
        activity: "idle",
        activeExecutionId: null,
        pendingCount: 0,
        storage,
        lastActivityAt: observedAt,
        closedAt: observedAt,
        lostReason: stopping ? settled.lostReason : shortText(reason),
      };
      yield* persistSession("stop", record);
      yield* appendJournal(
        "stop",
        live,
        stopping ? "session-stopped" : "session-lost",
        stopping ? null : reason,
        null,
      );
      yield* Ref.set(live.recordRef, record);
      yield* publishSession(record);
      yield* failPendingReady(
        live,
        computeError(
          "start",
          stopping ? "session-terminal" : "transport-failed",
          shortText(reason),
        ),
      );
      return record;
    });

  const endSessionUnderLease = (live: LiveComputeSession, reason: string) =>
    live.mutation.withPermits(1)(endSession(live, reason));

  const failClosedOnPersistenceError = (live: LiveComputeSession, error: ComputeOperationError) =>
    error.reason !== "persistence-failed"
      ? Effect.void
      : endSessionUnderLease(live, "Unable to persist compute session state.").pipe(
          Effect.ensuring(Scope.close(live.scope, Exit.void)),
          Effect.ignore,
        );

  const retireLiveSession = (live: LiveComputeSession) =>
    Effect.gen(function* () {
      yield* endSessionUnderLease(live, TRANSPORT_CLOSED_REASON);
      yield* failPendingReady(
        live,
        computeError("start", "transport-failed", TRANSPORT_CLOSED_REASON),
      );
      yield* Ref.update(sessionsRef, (sessions) => {
        const next = new Map(sessions);
        const key = sessionKey(live.projectId, live.sessionId);
        if (next.get(key) === live) next.delete(key);
        return next;
      });
      // The drain runs in the service scope rather than the session's own, so
      // it can close the session scope here without interrupting itself.
      yield* Scope.close(live.scope, Exit.void);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("compute session retirement failed", {
          projectId: live.projectId,
          sessionId: live.sessionId,
          cause,
        }),
      ),
    );

  // -------------------------------------------------------------------------
  // The event drain
  // -------------------------------------------------------------------------

  const applyEvent = (
    live: LiveComputeSession,
    event: ComputeTransportEvent,
  ): Effect.Effect<boolean, ComputeOperationError> =>
    Effect.gen(function* () {
      switch (event._tag) {
        case "ready": {
          const missing = missingComputeCapabilities(event.capabilities);
          if (missing.length > 0) {
            // Refusing here is better than discovering it from a stop button
            // that does nothing.
            yield* setSessionStatus("start", live, "failed", (record) => ({
              ...record,
              identity: event.runtime,
            }));
            yield* appendJournal(
              "start",
              live,
              "session-failed",
              `The runtime cannot ${missing.join(", ")}.`,
              null,
            );
            yield* failPendingReady(
              live,
              computeError(
                "start",
                "capability-missing",
                `This ${live.adapter.languageId} runtime cannot ${missing.join(", ")}, which a session needs.`,
              ),
            );
            yield* Scope.close(live.scope, Exit.void);
            return false;
          }
          const record = yield* setSessionStatus("start", live, "ready", (current) => ({
            ...current,
            identity: event.runtime,
          }));
          yield* appendJournal("start", live, "session-ready", null, null);
          yield* completePendingReady(live, record);
          return true;
        }
        case "accepted": {
          const record = yield* Ref.get(live.recordRef);
          if (event.generation !== record.generation) return false;
          const executionId = ComputeExecutionId.make(event.requestId);
          yield* setExecutionStatus("submit", live, executionId, "running");
          yield* appendJournal("submit", live, "execution-started", null, executionId);
          return false;
        }
        case "output": {
          yield* applyOutput(live, event);
          return false;
        }
        case "runtime-error": {
          const record = yield* Ref.get(live.recordRef);
          if (event.generation !== record.generation) return false;
          const executionId =
            event.requestId === null ? null : ComputeExecutionId.make(event.requestId);
          const diagnostics = live.adapter.normalizeDiagnostic(event.report);
          if (diagnostics.length === 0) return false;
          // The diagnostics land at the sequence the error happened at, so they
          // read in the transcript where the failure actually occurred. When an
          // adapter derives more than one they share that position rather than
          // inventing sequence numbers the runtime never minted.
          const outputs: ReadonlyArray<ComputeOutput> = diagnostics.map((diagnostic) => ({
            _tag: "diagnostic" as const,
            sequence: event.sequence,
            observedAt: event.observedAt,
            diagnostic,
          }));
          const retained: ComputeDiagnostic[] = [];
          for (const [index, output] of outputs.entries()) {
            const kept = yield* applyOutput(live, {
              _tag: "output",
              requestId: event.requestId,
              generation: event.generation,
              output,
              image: null,
            });
            if (kept && diagnostics[index] !== undefined) retained.push(diagnostics[index]);
          }
          if (executionId !== null && retained.length > 0) {
            yield* recordDiagnostics(live, executionId, retained);
          }
          return false;
        }
        case "completed": {
          const record = yield* Ref.get(live.recordRef);
          if (event.generation !== record.generation) return false;
          const executionId = ComputeExecutionId.make(event.requestId);
          yield* setExecutionStatus("submit", live, executionId, event.outcome);
          yield* Ref.update(live.queueRef, (queue) => finishComputeExecution(queue, executionId));
          yield* appendJournal("submit", live, "execution-finished", event.outcome, executionId);
          yield* syncQueueCounters("submit", live);
          return true;
        }
        case "restarted": {
          // Whatever the old namespace was still holding is settled here; the
          // restart command already cancelled everything that was waiting.
          yield* cancelEverything("restart", live, RESTART_DETAIL, "cancelled");
          const current = yield* Ref.get(live.recordRef);
          yield* Ref.set(live.recordRef, {
            ...current,
            generation: event.generation,
            identity: event.runtime,
          });
          const record = yield* setSessionStatus("restart", live, "ready");
          yield* appendJournal("restart", live, "session-restarted", null, null);
          yield* completePendingReady(live, record);
          return true;
        }
        case "lost": {
          yield* endSession(live, event.reason);
          return false;
        }
      }
    });

  const handleEvent = (live: LiveComputeSession, event: ComputeTransportEvent) =>
    live.mutation
      .withPermits(1)(applyEvent(live, event))
      .pipe(
        Effect.flatMap((advance) => (advance ? advanceQueue("submit", live) : Effect.void)),
        Effect.catchCause((cause) =>
          Effect.logError("compute session event handling failed", {
            projectId: live.projectId,
            sessionId: live.sessionId,
            event: event._tag,
            cause,
          }).pipe(
            Effect.andThen(endSessionUnderLease(live, "Unable to record runtime state.")),
            Effect.ignore,
          ),
        ),
      );

  const drain = (live: LiveComputeSession) =>
    live.channel.events.pipe(
      Stream.runForEach((event) => handleEvent(live, event)),
      Effect.catchCause((cause) =>
        Effect.logWarning("compute session transport failed", {
          projectId: live.projectId,
          sessionId: live.sessionId,
          cause,
        }).pipe(Effect.andThen(endSessionUnderLease(live, TRANSPORT_FAILED_REASON))),
      ),
      // However the stream ended -- a `lost` event, a transport failure, or a
      // clean shutdown -- this is the one place a session stops being live.
      Effect.ensuring(retireLiveSession(live)),
    );

  // -------------------------------------------------------------------------
  // Recovery
  // -------------------------------------------------------------------------

  const loadStoredSession = (
    operation: ComputeOperation,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
  ) =>
    store
      .loadSession(projectId, sessionId)
      .pipe(
        Effect.mapError(persistenceError(operation, "Unable to read the compute session record.")),
      );

  const recoverSession = (operation: ComputeOperation, record: ComputeSessionRecord) =>
    Effect.gen(function* () {
      const observedAt = yield* nowIso;
      const executions = yield* store
        .loadExecutions(record.projectId, record.sessionId)
        .pipe(Effect.mapError(persistenceError(operation, "Unable to read the session history.")));
      for (const execution of executions) {
        const result = execution.result;
        if (result !== null && TERMINAL_COMPUTE_EXECUTION_STATUSES.has(result.status)) continue;
        // A queued execution never reached the runtime, so it is cancelled; a
        // request with no result, or one that was running, was in flight and is
        // lost. Neither is replayed: re-running code a user did not ask for
        // again is worse than telling them it did not run.
        const wasQueued = result !== null && result.status === "queued";
        const status: ComputeExecutionStatus = wasQueued ? "cancelled" : "lost";
        // The transcript is the durable truth for counters, so recount it here
        // rather than trusting a result file that was being updated as the
        // server stopped.
        const counted = yield* store
          .loadOutputs(record.projectId, record.sessionId, execution.request.executionId)
          .pipe(
            Effect.map((loaded) => ({
              outputCount: loaded.outputs.length,
              outputBytes: loaded.outputs.reduce(
                (total, output) => total + computeOutputByteLength(output),
                0,
              ),
              truncated: loaded.corruptLineCount > 0,
            })),
            Effect.orElseSucceed(() => ({
              outputCount: result?.outputCount ?? 0,
              outputBytes: result?.outputBytes ?? 0,
              truncated: true,
            })),
          );
        yield* store
          .writeExecutionResult(record.projectId, record.sessionId, {
            executionId: execution.request.executionId,
            status,
            outcome: wasQueued ? "cancelled" : null,
            queuePosition: null,
            startedAt: result?.startedAt ?? null,
            finishedAt: observedAt,
            diagnostics: result?.diagnostics ?? [],
            outputCount: counted.outputCount,
            outputBytes: counted.outputBytes,
            truncated: (result?.truncated ?? false) || counted.truncated,
            failureReason: wasQueued
              ? (result?.failureReason ?? null)
              : shortText(SERVER_RESTART_REASON),
          })
          .pipe(
            Effect.mapError(
              persistenceError(operation, "Unable to record an interrupted execution."),
            ),
          );
      }
      const storage = yield* store
        .measureSessionStorage(record.projectId, record.sessionId)
        .pipe(Effect.orElseSucceed(() => record.storage));
      const status = yield* transitionComputeSessionStatus(record.status, "lost").pipe(
        Effect.orDie,
      );
      const recovered: ComputeSessionRecord = {
        ...record,
        status,
        activity: "idle",
        activeExecutionId: null,
        pendingCount: 0,
        storage,
        lastActivityAt: observedAt,
        closedAt: observedAt,
        lostReason: shortText(SERVER_RESTART_REASON),
      };
      yield* store
        .writeSession(recovered)
        .pipe(
          Effect.mapError(persistenceError(operation, "Unable to record a recovered session.")),
        );
      const journal = yield* store
        .loadJournal(record.projectId, record.sessionId)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<ComputeSessionJournalEntry> => []));
      yield* store
        .appendJournal(record.projectId, record.sessionId, {
          sequence: (journal.at(-1)?.sequence ?? -1) + 1,
          observedAt,
          event: "session-recovered",
          generation: record.generation,
          executionId: null,
          detail: shortText(SERVER_RESTART_REASON),
        })
        .pipe(
          Effect.mapError(persistenceError(operation, "Unable to record a recovered session.")),
        );
      yield* publishSession(recovered);
    });

  /**
   * Settles what a previous run of this server left behind, once per project.
   *
   * Lazy rather than eager at startup: a machine with fifty projects should not
   * read fifty session histories to open one of them, and a project nobody
   * touches costs nothing.
   */
  const ensureProjectRecovered = (operation: ComputeOperation, projectId: ComputeProjectId) =>
    Effect.gen(function* () {
      if ((yield* Ref.get(recoveredProjectsRef)).has(projectId)) return;
      yield* recoveryLock.withPermits(1)(
        Effect.gen(function* () {
          // Recheck under the lease so concurrent readers share one scan.
          if ((yield* Ref.get(recoveredProjectsRef)).has(projectId)) return;
          const stored = yield* store
            .loadSessions(projectId)
            .pipe(Effect.mapError(persistenceError(operation, "Unable to read compute sessions.")));
          const live = yield* Ref.get(sessionsRef);
          for (const record of stored) {
            if (TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)) continue;
            // A session this process is holding open is not an orphan.
            if (live.has(sessionKey(projectId, record.sessionId))) continue;
            yield* recoverSession(operation, record);
          }
          yield* Ref.update(recoveredProjectsRef, (projects) => new Set(projects).add(projectId));
        }),
      );
    });

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  const requireLiveSession = (
    operation: ComputeOperation,
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
  ) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered(operation, projectId);
      const live = (yield* Ref.get(sessionsRef)).get(sessionKey(projectId, sessionId));
      if (live !== undefined) return live;
      const stored = yield* loadStoredSession(operation, projectId, sessionId);
      return yield* stored === null
        ? computeError(
            operation,
            "session-not-found",
            `There is no compute session '${sessionId}' in this project.`,
          )
        : computeError(
            operation,
            "session-terminal",
            `Compute session '${sessionId}' is ${stored.status} and is not running.`,
          );
    });

  const requireCurrentGeneration = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    record: ComputeSessionRecord,
    expectedGeneration: ComputeSessionGeneration,
  ) =>
    Effect.gen(function* () {
      const check = checkComputeSessionGeneration(record.generation, expectedGeneration);
      if (check._tag === "current") return;
      if (check._tag === "ahead") {
        // Nothing hands out a generation this session has not reached, so a
        // caller holding one is a defect worth seeing rather than a user error.
        yield* Effect.logWarning("compute command claimed a future session generation", {
          projectId: live.projectId,
          sessionId: live.sessionId,
          currentGeneration: check.currentGeneration,
          expectedGeneration,
        });
      }
      return yield* computeError(
        operation,
        "generation-stale",
        `This session is now at generation ${check.currentGeneration} and the command was for generation ${expectedGeneration}; it has been restarted since you last saw it.`,
      );
    });

  const openLiveSession = (input: ComputeStartSessionInput) =>
    Effect.gen(function* () {
      const binding = bindings.find(
        (candidate) => candidate.adapter.languageId === input.languageId,
      );
      if (binding === undefined) {
        return yield* computeError(
          "start",
          "runtime-missing",
          `No compute runtime is registered for '${input.languageId}'.`,
        );
      }
      const projectRoot = yield* Effect.try({
        try: () => validateProjectRoot(input.workingDirectory),
        catch: (cause) =>
          computeError(
            "start",
            "runtime-unusable",
            "A session working directory must be an absolute, canonical path.",
            cause,
          ),
      });
      const { environment } = sanitizeComputeEnvironment(definedEnvironment(hostEnvironment));
      const profiles = yield* binding.adapter
        .discover({ projectRoot, configuredExecutable: input.configuredExecutable })
        .pipe(
          Effect.mapError((cause) =>
            computeError("start", "runtime-missing", cause.message, cause),
          ),
        );
      const candidate = profiles[0];
      if (candidate === undefined) {
        return yield* computeError(
          "start",
          "runtime-missing",
          `No ${input.languageId} runtime was found for this project.`,
        );
      }
      const verification = yield* binding.adapter
        .verify({ profile: candidate, cwd: projectRoot, environment })
        .pipe(
          Effect.mapError((cause) =>
            computeError("start", "runtime-unusable", cause.message, cause),
          ),
        );
      if (verification.readiness !== "ready") {
        return yield* computeError(
          "start",
          "runtime-unusable",
          verification.message ??
            `The ${input.languageId} runtime at ${candidate.executable} cannot be used.`,
        );
      }
      const launch = yield* binding.adapter
        .prepareLaunch({ profile: verification.profile, cwd: projectRoot, environment })
        .pipe(
          Effect.mapError((cause) =>
            computeError("start", "runtime-unusable", cause.message, cause),
          ),
        );
      // A fingerprint is a nicety rather than a precondition: a session whose
      // environment cannot be summarized is still a session a user can work in.
      const environmentFingerprint = yield* binding.adapter
        .fingerprintEnvironment(verification.profile)
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("compute environment fingerprint unavailable", {
              sessionId: input.sessionId,
              message: cause.message,
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
      const sessionScope = yield* Scope.make("sequential");
      const channel = yield* binding.transport
        .open({
          sessionId: input.sessionId,
          generation: INITIAL_COMPUTE_SESSION_GENERATION,
          languageId: binding.adapter.languageId,
          transportKind: binding.adapter.transportKind,
          launch,
          requiredCapabilities: [...REQUIRED_COMPUTE_CAPABILITIES],
        })
        .pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.tapError(() => Scope.close(sessionScope, Exit.void)),
          Effect.mapError((cause) =>
            computeError("start", "transport-failed", cause.message, cause),
          ),
        );
      const createdAt = yield* nowIso;
      const record: ComputeSessionRecord = {
        sessionId: input.sessionId,
        projectId: input.projectId,
        label: labelText(input.label),
        languageId: binding.adapter.languageId,
        transportKind: binding.adapter.transportKind,
        workingDirectory: shortText(projectRoot),
        runtime: verification.profile,
        identity: null,
        environmentFingerprint,
        generation: INITIAL_COMPUTE_SESSION_GENERATION,
        status: "starting",
        activity: "idle",
        activeExecutionId: null,
        pendingCount: 0,
        storage: EMPTY_COMPUTE_SESSION_STORAGE,
        createdAt,
        lastActivityAt: createdAt,
        closedAt: null,
        lostReason: null,
      };
      const ready = yield* Deferred.make<ComputeSessionRecord, ComputeOperationError>();
      const live: LiveComputeSession = {
        projectId: input.projectId,
        sessionId: input.sessionId,
        adapter: binding.adapter,
        scope: sessionScope,
        channel,
        mutation: yield* Semaphore.make(1),
        recordRef: yield* Ref.make(record),
        queueRef: yield* Ref.make(EMPTY_COMPUTE_QUEUE),
        pendingRef: yield* Ref.make<ReadonlyMap<ComputeExecutionId, ComputeExecutionRecord>>(
          new Map(),
        ),
        readyRef: yield* Ref.make<Deferred.Deferred<
          ComputeSessionRecord,
          ComputeOperationError
        > | null>(ready),
        journalRef: yield* Ref.make(0),
        sessionOutputRef: yield* Ref.make({ bytes: 0, truncated: false }),
      };
      yield* persistSession("start", record).pipe(
        Effect.tapError(() => Scope.close(sessionScope, Exit.void)),
      );
      yield* appendJournal("start", live, "session-created", null, null).pipe(
        Effect.tapError(() => Scope.close(sessionScope, Exit.void)),
      );
      yield* Ref.update(sessionsRef, (sessions) =>
        new Map(sessions).set(sessionKey(input.projectId, input.sessionId), live),
      );
      yield* publishSession(record);
      // The drain lives in the service scope, not the session's, so that it can
      // close the session's scope when the runtime is gone.
      yield* drain(live).pipe(Effect.forkIn(serviceScope));
      // The transport has already completed its handshake, so `ready` is a
      // report the drain is about to process rather than something to wait on
      // with a clock. Returning the ready record means a caller never has to
      // poll for the identity of what it just started.
      return yield* Deferred.await(ready);
    });

  const startSession = (input: ComputeStartSessionInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("start", input.projectId);
      // Starts are serialized: discovery, verification, and a process launch are
      // slow and rare, and two runtimes racing to claim the same runtime
      // directory is not a state worth supporting.
      return yield* startLock.withPermits(1)(
        Effect.gen(function* () {
          const key = sessionKey(input.projectId, input.sessionId);
          const existing = (yield* Ref.get(sessionsRef)).get(key);
          // Idempotent by session id: a retried start must not leave a second
          // runtime behind for the same panel. An entry that has already ended
          // is on its way out of the registry and is a history rather than a
          // session to hand back, so it falls through to the answer below.
          if (existing !== undefined) {
            const record = yield* Ref.get(existing.recordRef);
            if (!TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)) return record;
          }
          const stored = yield* loadStoredSession("start", input.projectId, input.sessionId);
          if (stored !== null) {
            // Every stored session is terminal by now: recovery ran above. A
            // name that has been used names a history, and reusing it would
            // write a second session's output into the first one's transcript.
            return yield* computeError(
              "start",
              "session-terminal",
              `Compute session '${input.sessionId}' has already ended; start a new session rather than reusing its name.`,
            );
          }
          return yield* openLiveSession(input);
        }),
      );
    });

  const admitSubmission = (live: LiveComputeSession, input: ComputeSubmitExecutionInput) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      yield* requireCurrentGeneration("submit", live, record, input.expectedGeneration);
      if (record.status !== "starting" && record.status !== "ready") {
        return yield* computeError(
          "submit",
          "session-not-running",
          `This session is ${record.status} and cannot run code.`,
        );
      }
      const sameSubmission = (request: ComputeExecutionRequestRecord) =>
        request.sessionId === live.sessionId &&
        request.generation === record.generation &&
        request.codeHash === codeHash(input.code) &&
        request.code === input.code &&
        JSON.stringify(request.source) === JSON.stringify(input.source);
      // Idempotent only for the same immutable request. Reusing an identifier
      // for different code would otherwise overwrite history or return the
      // result of work the caller did not submit.
      const existing = (yield* Ref.get(live.pendingRef)).get(input.executionId);
      if (existing !== undefined) {
        if (sameSubmission(existing.request)) return { execution: existing, dispatch: null };
        return yield* computeError(
          "submit",
          "execution-conflict",
          `Execution '${input.executionId}' already names different submitted code.`,
        );
      }
      const stored = yield* store
        .loadExecution(live.projectId, live.sessionId, input.executionId)
        .pipe(Effect.mapError(persistenceError("submit", "Unable to inspect the execution id.")));
      if (stored !== null && !sameSubmission(stored.request)) {
        return yield* computeError(
          "submit",
          "execution-conflict",
          `Execution '${input.executionId}' already names different submitted code.`,
        );
      }
      if (
        stored?.result !== null &&
        stored?.result !== undefined &&
        TERMINAL_COMPUTE_EXECUTION_STATUSES.has(stored.result.status)
      ) {
        return { execution: stored, dispatch: null };
      }
      const admission = yield* admitComputeExecution(
        yield* Ref.get(live.queueRef),
        input.executionId,
      ).pipe(
        Effect.tapError((cause) =>
          appendJournal("submit", live, "queue-rejected", cause.message, input.executionId),
        ),
        Effect.mapError((cause) => computeError("submit", "queue-full", cause.message, cause)),
      );
      const submittedAt = yield* nowIso;
      const request: ComputeExecutionRequestRecord = stored?.request ?? {
        executionId: input.executionId,
        sessionId: live.sessionId,
        generation: record.generation,
        code: input.code,
        codeHash: codeHash(input.code),
        source: input.source,
        submittedAt,
        environmentFingerprint: record.environmentFingerprint,
      };
      const result: ComputeExecutionResultRecord = stored?.result ?? {
        executionId: input.executionId,
        status: "queued",
        outcome: null,
        queuePosition: admission.position,
        startedAt: null,
        finishedAt: null,
        diagnostics: [],
        outputCount: 0,
        outputBytes: 0,
        truncated: false,
        failureReason: null,
      };
      // The request is durable before anything is told it exists, so a crash
      // leaves a request with no result -- which is exactly the shape recovery
      // reads as an execution that was in flight.
      if (stored === null) {
        yield* store
          .writeExecutionRequest(live.projectId, request)
          .pipe(
            Effect.mapError(persistenceError("submit", "Unable to record the submitted code.")),
          );
      }
      yield* persistResult("submit", live, result);
      const execution: ComputeExecutionRecord = { request, result };
      yield* appendJournal("submit", live, "execution-submitted", null, input.executionId);
      yield* Ref.set(live.queueRef, admission.state);
      yield* Ref.update(live.pendingRef, (map) => new Map(map).set(input.executionId, execution));
      yield* syncQueueCounters("submit", live);
      yield* publishExecution(live, execution);
      const next = yield* takeNextDispatch("submit", live);
      const current = (yield* Ref.get(live.pendingRef)).get(input.executionId) ?? execution;
      return { execution: current, dispatch: next };
    });

  const submitExecution = (input: ComputeSubmitExecutionInput) =>
    Effect.gen(function* () {
      const live = yield* requireLiveSession("submit", input.projectId, input.sessionId);
      const admitted = yield* live.mutation
        .withPermits(1)(admitSubmission(live, input))
        .pipe(Effect.tapError((error) => failClosedOnPersistenceError(live, error)));
      yield* dispatch(live, admitted.dispatch);
      return admitted.execution;
    });

  const loadStoredExecution = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    executionId: ComputeExecutionId,
  ) =>
    store
      .loadExecution(live.projectId, live.sessionId, executionId)
      .pipe(Effect.mapError(persistenceError(operation, "Unable to read the session history.")));

  const applyInterruptOutcome = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    executionId: ComputeExecutionId,
    outcome: ComputeInterruptOutcome,
  ) =>
    Effect.gen(function* () {
      switch (outcome) {
        case "interrupted":
        case "terminal":
          // What became of the execution arrives on the event stream; that the
          // signal landed is all this answered.
          break;
        case "rejected": {
          // The runtime refused the signal, so the execution is still running
          // and saying otherwise would be a lie.
          yield* setExecutionStatus(operation, live, executionId, "running");
          break;
        }
        case "timeout": {
          // The runtime did not answer at all. The execution is in an unknown
          // state and it is the session that is wrong, not the cell: the next
          // thing the runtime says will clear this.
          const current = yield* Ref.get(live.recordRef);
          const lastActivityAt = yield* nowIso;
          const record: ComputeSessionRecord = {
            ...current,
            activity: "unresponsive",
            lastActivityAt,
          };
          yield* persistSession(operation, record);
          yield* Ref.set(live.recordRef, record);
          yield* appendJournal(
            operation,
            live,
            "session-unresponsive",
            INTERRUPT_TIMEOUT_DETAIL,
            executionId,
          );
          yield* publishSession(record);
          break;
        }
      }
      const live_ = (yield* Ref.get(live.pendingRef)).get(executionId);
      if (live_ !== undefined) return live_;
      const stored = yield* loadStoredExecution(operation, live, executionId);
      if (stored !== null) return stored;
      return yield* computeError(
        operation,
        "execution-not-found",
        `There is no execution '${executionId}' in this session.`,
      );
    });

  const interruptActive = (
    operation: ComputeOperation,
    live: LiveComputeSession,
    target: InterruptTarget,
  ) =>
    live.channel
      .interrupt({
        requestId: ComputeRequestId.make(target.executionId),
        expectedGeneration: target.generation,
      })
      .pipe(
        Effect.mapError((cause) =>
          computeError(operation, "transport-failed", cause.message, cause),
        ),
        Effect.flatMap((outcome) =>
          live.mutation.withPermits(1)(
            applyInterruptOutcome(operation, live, target.executionId, outcome),
          ),
        ),
      );

  const decideCancellation = (live: LiveComputeSession, input: ComputeExecutionCommandInput) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      yield* requireCurrentGeneration("cancel", live, record, input.expectedGeneration);
      const outcome = cancelComputeExecution(yield* Ref.get(live.queueRef), input.executionId);
      if (outcome.removed === "pending") {
        // It never reached the runtime, so there is nothing to interrupt.
        yield* Ref.set(live.queueRef, outcome.state);
        const execution = yield* setExecutionStatus("cancel", live, input.executionId, "cancelled");
        yield* appendJournal("cancel", live, "execution-cancelled", null, input.executionId);
        yield* syncQueueCounters("cancel", live);
        if (execution !== null) return { execution, interrupt: null };
      } else if (outcome.removed === "active") {
        const execution = yield* setExecutionStatus(
          "cancel",
          live,
          input.executionId,
          "interrupting",
        );
        if (execution !== null) {
          return {
            execution,
            interrupt: {
              executionId: input.executionId,
              generation: record.generation,
            } satisfies InterruptTarget,
          };
        }
      }
      const stored = yield* loadStoredExecution("cancel", live, input.executionId);
      if (stored === null) {
        return yield* computeError(
          "cancel",
          "execution-not-found",
          `There is no execution '${input.executionId}' in this session.`,
        );
      }
      return yield* computeError(
        "cancel",
        "execution-already-finished",
        `Execution '${input.executionId}' has already ${stored.result?.status ?? "ended"}.`,
      );
    });

  const cancelExecution = (input: ComputeExecutionCommandInput) =>
    Effect.gen(function* () {
      const live = yield* requireLiveSession("cancel", input.projectId, input.sessionId);
      const decision = yield* live.mutation
        .withPermits(1)(decideCancellation(live, input))
        .pipe(Effect.tapError((error) => failClosedOnPersistenceError(live, error)));
      if (decision.interrupt === null) return decision.execution;
      return yield* interruptActive("cancel", live, decision.interrupt).pipe(
        Effect.tapError((error) => failClosedOnPersistenceError(live, error)),
      );
    });

  const interruptSession = (input: ComputeSessionCommandInput) =>
    Effect.gen(function* () {
      const live = yield* requireLiveSession("interrupt", input.projectId, input.sessionId);
      const target = yield* live.mutation
        .withPermits(1)(
          Effect.gen(function* () {
            const record = yield* Ref.get(live.recordRef);
            yield* requireCurrentGeneration("interrupt", live, record, input.expectedGeneration);
            const queue = yield* Ref.get(live.queueRef);
            // Interrupting an idle session is not an error; there is simply
            // nothing to interrupt.
            if (queue.active === null) return null;
            yield* setExecutionStatus("interrupt", live, queue.active, "interrupting");
            return {
              executionId: queue.active,
              generation: record.generation,
            } satisfies InterruptTarget;
          }),
        )
        .pipe(Effect.tapError((error) => failClosedOnPersistenceError(live, error)));
      if (target !== null) {
        yield* interruptActive("interrupt", live, target).pipe(
          Effect.tapError((error) => failClosedOnPersistenceError(live, error)),
        );
      }
      return yield* Ref.get(live.recordRef);
    });

  const restartSession = (input: ComputeSessionCommandInput) =>
    Effect.gen(function* () {
      const live = yield* requireLiveSession("restart", input.projectId, input.sessionId);
      const plan = yield* live.mutation
        .withPermits(1)(
          Effect.gen(function* () {
            const record = yield* Ref.get(live.recordRef);
            yield* requireCurrentGeneration("restart", live, record, input.expectedGeneration);
            if (record.status !== "ready") {
              return yield* computeError(
                "restart",
                "session-not-running",
                `This session is ${record.status} and cannot be restarted.`,
              );
            }
            // Everything waiting is cancelled here, because it was written for a
            // namespace that is about to stop existing and must not silently run
            // in the one that replaces it. History is untouched.
            const drained = drainComputeQueue(yield* Ref.get(live.queueRef));
            yield* Ref.set(live.queueRef, drained.state);
            for (const executionId of drained.cancelled) {
              yield* setExecutionStatus("restart", live, executionId, "cancelled");
              yield* appendJournal(
                "restart",
                live,
                "execution-cancelled",
                RESTART_DETAIL,
                executionId,
              );
            }
            yield* setSessionStatus("restart", live, "restarting");
            yield* syncQueueCounters("restart", live);
            const ready = yield* Deferred.make<ComputeSessionRecord, ComputeOperationError>();
            yield* Ref.set(live.readyRef, ready);
            return { ready, generation: record.generation };
          }),
        )
        .pipe(Effect.tapError((error) => failClosedOnPersistenceError(live, error)));
      yield* live.channel
        .restart({
          expectedGeneration: plan.generation,
          nextGeneration: nextComputeSessionGeneration(plan.generation),
        })
        .pipe(
          Effect.mapError((cause) =>
            computeError("restart", "transport-failed", cause.message, cause),
          ),
          // Restart is destructive and a failed acknowledgement is ambiguous.
          // The transport reports loss; never claim the old namespace is ready
          // after asking it to be replaced.
          Effect.tapError((error) =>
            live.mutation.withPermits(1)(Deferred.fail(plan.ready, error)),
          ),
        );
      return yield* Deferred.await(plan.ready);
    });

  const closeLiveSession = (live: LiveComputeSession, generation: ComputeSessionGeneration) =>
    Effect.gen(function* () {
      // A shutdown request that fails is not a reason to keep the process: the
      // scope closing below is what actually ends it.
      yield* live.channel.shutdown({ expectedGeneration: generation }).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("compute session shutdown request failed", {
            projectId: live.projectId,
            sessionId: live.sessionId,
            message: cause.message,
          }),
        ),
        Effect.ignore,
      );
      // Ending the stream may already have retired the session through the
      // drain; `endSession` is written so whichever arrives second finds a
      // terminal record and returns it unchanged.
      const record = yield* endSessionUnderLease(live, STOP_DETAIL);
      yield* Scope.close(live.scope, Exit.void);
      return record;
    });

  /** Announces the stop, or reports that the session has already ended. */
  const beginStop = (live: LiveComputeSession) =>
    Effect.gen(function* () {
      const record = yield* Ref.get(live.recordRef);
      if (TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)) return null;
      // A second stop while the first is in flight is not an error; it is a
      // user pressing the button twice.
      if (record.status !== "stopping") {
        yield* setSessionStatus("stop", live, "stopping");
        yield* appendJournal("stop", live, "session-stopping", null, null);
      }
      return record.generation;
    });

  const stopSession = (input: ComputeSessionCommandInput) =>
    Effect.gen(function* () {
      const live = yield* requireLiveSession("stop", input.projectId, input.sessionId);
      const generation = yield* live.mutation
        .withPermits(1)(
          Effect.gen(function* () {
            const record = yield* Ref.get(live.recordRef);
            yield* requireCurrentGeneration("stop", live, record, input.expectedGeneration);
            return yield* beginStop(live);
          }),
        )
        .pipe(Effect.tapError((error) => failClosedOnPersistenceError(live, error)));
      if (generation === null) return yield* Ref.get(live.recordRef);
      return yield* closeLiveSession(live, generation).pipe(
        Effect.tapError((error) => failClosedOnPersistenceError(live, error)),
      );
    });

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  const listSessions = (input: ComputeListSessionsInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("list", input.projectId);
      const stored = yield* store
        .loadSessions(input.projectId)
        .pipe(Effect.mapError(persistenceError("list", "Unable to read compute sessions.")));
      const merged = new Map(stored.map((record) => [record.sessionId, record] as const));
      for (const session of (yield* Ref.get(sessionsRef)).values()) {
        if (session.projectId !== input.projectId) continue;
        // A live record is fresher than the file by exactly the fields that are
        // deliberately not written on every line of output.
        merged.set(session.sessionId, yield* Ref.get(session.recordRef));
      }
      return [...merged.values()].toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
    });

  const getSession = (input: ComputeGetSessionInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("get", input.projectId);
      const live = (yield* Ref.get(sessionsRef)).get(sessionKey(input.projectId, input.sessionId));
      if (live !== undefined) return yield* Ref.get(live.recordRef);
      return yield* loadStoredSession("get", input.projectId, input.sessionId);
    });

  const listExecutions = (input: ComputeListExecutionsInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("list", input.projectId);
      const stored = yield* store
        .loadExecutions(input.projectId, input.sessionId)
        .pipe(Effect.mapError(persistenceError("list", "Unable to read the session history.")));
      const live = (yield* Ref.get(sessionsRef)).get(sessionKey(input.projectId, input.sessionId));
      if (live === undefined) return stored;
      const pending = yield* Ref.get(live.pendingRef);
      return stored.map((execution) => pending.get(execution.request.executionId) ?? execution);
    });

  const listOutputs = (input: ComputeListOutputsInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("outputs", input.projectId);
      return yield* store
        .loadOutputs(input.projectId, input.sessionId, input.executionId)
        .pipe(Effect.mapError(persistenceError("outputs", "Unable to read the transcript.")));
    });

  const listJournal = (input: ComputeGetSessionInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("get", input.projectId);
      return yield* store
        .loadJournal(input.projectId, input.sessionId)
        .pipe(Effect.mapError(persistenceError("get", "Unable to read what the session did.")));
    });

  const resolveOutputImage = (ref: ComputeOutputResourceRef) =>
    store
      .resolveOutputImage(ref)
      .pipe(Effect.mapError(persistenceError("resolve", "Unable to resolve the compute output.")));

  const subscribeSessions = (input: ComputeSubscribeSessionsInput) =>
    Effect.gen(function* () {
      yield* ensureProjectRecovered("subscribe", input.projectId);
      const subscription = yield* PubSub.subscribe(pubsub);
      // Snapshots are taken after subscribing and stamped with the sequence the
      // stream is filtered from, so a client sees every session exactly once and
      // nothing that happened while it was mounting is lost.
      const boundarySequence = yield* Ref.get(eventSequenceRef);
      const sessions = yield* listSessions({ projectId: input.projectId });
      const snapshots = sessions.map((session) => ({
        _tag: "session-snapshot" as const,
        eventSequence: boundarySequence,
        session,
      }));
      return Stream.concat(
        Stream.fromIterable(snapshots),
        Stream.fromSubscription(subscription).pipe(
          Stream.filter(
            (event) =>
              event.eventSequence >= boundarySequence && eventProjectId(event) === input.projectId,
          ),
        ),
      );
    });

  // -------------------------------------------------------------------------
  // Idle sweep and shutdown
  // -------------------------------------------------------------------------

  const idleTimeoutMs = options.idleTimeoutMs;

  const sweepIdleSessions = Effect.gen(function* () {
    if (idleTimeoutMs === null) return;
    const now = yield* Clock.currentTimeMillis;
    for (const live of (yield* Ref.get(sessionsRef)).values()) {
      const record = yield* Ref.get(live.recordRef);
      if (record.status !== "ready" || record.activity !== "idle") continue;
      const queue = yield* Ref.get(live.queueRef);
      if (queue.active !== null || queue.pending.length > 0) continue;
      const idleForMs = now - Date.parse(record.lastActivityAt);
      if (Number.isNaN(idleForMs) || idleForMs < idleTimeoutMs) continue;
      yield* Effect.logInfo("compute session stopped after being idle", {
        projectId: live.projectId,
        sessionId: live.sessionId,
        idleForMs,
      });
      yield* stopSession({
        projectId: live.projectId,
        sessionId: live.sessionId,
        expectedGeneration: record.generation,
      }).pipe(Effect.ignore);
    }
  });

  if (idleTimeoutMs !== null) {
    // A pass every quarter of the timeout keeps the check cheap and bounds how
    // late a session is reclaimed to a fraction of the window a user chose.
    const interval = Duration.millis(
      Math.max(IDLE_SWEEP_MINIMUM_MS, Math.floor(idleTimeoutMs / 4)),
    );
    const sweepLoop: Effect.Effect<never> = Effect.sleep(interval).pipe(
      Effect.andThen(
        sweepIdleSessions.pipe(
          Effect.catchCause((cause) => Effect.logError("compute idle sweep failed", { cause })),
        ),
      ),
      Effect.andThen(Effect.suspend(() => sweepLoop)),
    );
    yield* sweepLoop.pipe(Effect.forkIn(serviceScope));
  }

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // Every runtime this process started is stopped before the process goes,
      // so a user does not come back to orphaned kernels holding their ports.
      const live = [...(yield* Ref.get(sessionsRef)).values()];
      yield* Effect.forEach(
        live,
        (session) =>
          session.mutation
            .withPermits(1)(beginStop(session))
            .pipe(
              Effect.flatMap((generation) =>
                generation === null ? Effect.void : closeLiveSession(session, generation),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("compute session did not stop cleanly", {
                  projectId: session.projectId,
                  sessionId: session.sessionId,
                  cause,
                }),
              ),
            ),
        { discard: true, concurrency: 4 },
      );
      yield* Scope.close(serviceScope, Exit.void);
    }),
  );

  return ComputeSessionService.of({
    startSession,
    submitExecution,
    cancelExecution,
    interruptSession,
    restartSession,
    stopSession,
    listSessions,
    getSession,
    listExecutions,
    listOutputs,
    listJournal,
    resolveOutputImage,
    subscribeSessions,
  });
});

/**
 * The layer for a host whose runtimes have to be found before they can be used.
 *
 * Runtimes are injected rather than imported, so a test can drive the whole
 * coordinator against a simulated runtime and a second language costs a binding
 * rather than a branch.
 *
 * They arrive as an effect because a production binding is not a value a caller
 * already holds: the bridge script has to be located on disk and the process
 * ports have to be acquired. Keeping that inside layer construction means a
 * host that cannot find its runtime says so while it is starting rather than
 * the first time someone opens a panel.
 */
export const layerWithRuntimeBindings = <E, R>(
  bindings: Effect.Effect<ReadonlyArray<ComputeRuntimeBinding>, E, R>,
  options: ComputeSessionServiceOptions = DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
) =>
  Layer.effect(ComputeSessionService, make).pipe(
    Layer.provide(Layer.effect(ComputeRuntimeBindings, bindings)),
    Layer.provide(Layer.succeed(ComputeSessionServiceConfig, options)),
  );

export const layerWithRuntimes = (
  bindings: ReadonlyArray<ComputeRuntimeBinding>,
  options: ComputeSessionServiceOptions = DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
) => layerWithRuntimeBindings(Effect.succeed(bindings), options);

export const layer = Layer.effect(ComputeSessionService, make);
