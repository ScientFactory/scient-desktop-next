import type {
  ComputeSessionRecord,
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import { TERMINAL_COMPUTE_SESSION_STATUSES } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";

import {
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";

type StopResult = AtomCommandResult<ComputeSessionRecord, unknown>;
type GetResult = AtomCommandResult<ComputeSessionRecord | null, unknown>;

/** A cached exact-id read must never overwrite a newer stream/list observation. */
export function mergeComputeSessionRecords(
  ...sources: ReadonlyArray<Iterable<ComputeSessionRecord>>
): ComputeSessionRecord[] {
  const byId = new Map<string, ComputeSessionRecord>();
  for (const source of sources) {
    for (const record of source) {
      const previous = byId.get(record.sessionId);
      if (
        previous !== undefined &&
        (record.generation < previous.generation ||
          (record.generation === previous.generation &&
            (record.lastActivityAt < previous.lastActivityAt ||
              (TERMINAL_COMPUTE_SESSION_STATUSES.has(previous.status) &&
                !TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status)))))
      )
        continue;
      byId.set(record.sessionId, record);
    }
  }
  return [...byId.values()];
}

export interface ComputeContextCloseInput {
  readonly contextId: ComputeContextId;
  readonly stopSession: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: {
      readonly cwd: string;
      readonly sessionId: ComputeSessionId;
      readonly expectedGeneration: ComputeSessionGeneration;
    };
  }) => Promise<StopResult>;
  readonly getSession: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly cwd: string; readonly sessionId: ComputeSessionId };
  }) => Promise<GetResult>;
}

export interface ComputeContextCloseResult {
  readonly closed: boolean;
  readonly contextId: ComputeContextId;
  readonly error: string | null;
}

function resultError(result: {
  readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"];
}): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Unable to stop the compute context.";
}

function isTerminal(record: ComputeSessionRecord | null): record is ComputeSessionRecord {
  return record !== null && TERMINAL_COMPUTE_SESSION_STATUSES.has(record.status);
}

function isTerminalForSession(
  record: ComputeSessionRecord | null,
  sessionId: ComputeSessionId,
): record is ComputeSessionRecord {
  return record !== null && record.sessionId === sessionId && isTerminal(record);
}

function thrownError(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to stop the compute context.";
}

/**
 * Stop exactly one owner. A generation refresh may retry once, but it never retargets
 * another session and it leaves the surface present when shutdown cannot be confirmed.
 */
export async function closeComputeContext(
  input: ComputeContextCloseInput,
): Promise<ComputeContextCloseResult> {
  const binding = getComputeContext(input.contextId);
  if (binding === null || binding.sessionId === null) {
    return { closed: true, contextId: input.contextId, error: null };
  }

  useComputeContextStore.getState().markClosing(input.contextId);
  const sessionId = binding.sessionId;
  let expectedGeneration = binding.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let stopped: StopResult;
    try {
      stopped = await input.stopSession({
        environmentId: binding.environmentId,
        input: { cwd: binding.cwd, sessionId, expectedGeneration },
      });
    } catch (error) {
      const message = thrownError(error);
      useComputeContextStore.getState().markCloseFailed({
        contextId: input.contextId,
        error: message,
      });
      return { closed: false, contextId: input.contextId, error: message };
    }
    if (stopped._tag === "Success" && isTerminalForSession(stopped.value, sessionId)) {
      useComputeContextStore.getState().markSessionTerminal({
        contextId: input.contextId,
        sessionId,
        generation: stopped.value.generation,
        lifecycle: "terminal",
      });
      return { closed: true, contextId: input.contextId, error: null };
    }
    if (isAtomCommandInterrupted(stopped)) {
      const error = "Stopping the compute context was interrupted.";
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }

    // Stop may have lost a race with restart. Re-read this exact owned id before
    // retrying; a terminal record is already a confirmed close.
    let current: GetResult;
    try {
      current = await input.getSession({
        environmentId: binding.environmentId,
        input: { cwd: binding.cwd, sessionId },
      });
    } catch (error) {
      const message = thrownError(error);
      useComputeContextStore.getState().markCloseFailed({
        contextId: input.contextId,
        error: message,
      });
      return { closed: false, contextId: input.contextId, error: message };
    }
    if (current._tag === "Success" && isTerminalForSession(current.value, sessionId)) {
      useComputeContextStore.getState().markSessionTerminal({
        contextId: input.contextId,
        sessionId,
        generation: current.value.generation,
        lifecycle: "terminal",
      });
      return { closed: true, contextId: input.contextId, error: null };
    }
    if (current._tag !== "Success" || current.value === null) {
      const error =
        current._tag === "Success"
          ? stopped._tag === "Failure"
            ? resultError(stopped)
            : "Stop did not return a terminal compute session."
          : resultError(current);
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    if (current.value.sessionId !== sessionId) {
      const error = "The owned compute session changed while closing.";
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    if (current.value.generation === expectedGeneration || attempt === 1) {
      const error =
        stopped._tag === "Success"
          ? "Stop returned a non-terminal compute session."
          : resultError(stopped);
      useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
      return { closed: false, contextId: input.contextId, error };
    }
    expectedGeneration = current.value.generation;
    useComputeContextStore.getState().updateClosingGeneration({
      contextId: input.contextId,
      sessionId,
      generation: expectedGeneration,
    });
  }

  const error = "Unable to confirm compute context shutdown.";
  useComputeContextStore.getState().markCloseFailed({ contextId: input.contextId, error });
  return { closed: false, contextId: input.contextId, error };
}
