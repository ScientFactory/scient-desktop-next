import type { ComputeSessionRecord } from "@t3tools/contracts";
import { ComputeSessionGeneration, ComputeSessionId, EnvironmentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { closeComputeContext, mergeComputeSessionRecords } from "./computeContextCoordinator";
import { ensureComputeContext, useComputeContextStore } from "./computeContextStore";

const environmentId = EnvironmentId.make("environment-1");
const contextId = "context-close" as Parameters<typeof ensureComputeContext>[0]["contextId"];
const sessionId = ComputeSessionId.make("session-close");
const otherSessionId = ComputeSessionId.make("session-other");

const record = (
  generation: number,
  status: ComputeSessionRecord["status"],
  ownedSessionId = sessionId,
): ComputeSessionRecord =>
  ({
    sessionId: ownedSessionId,
    generation: ComputeSessionGeneration.make(generation),
    status,
  }) as ComputeSessionRecord;

beforeEach(() => {
  useComputeContextStore.setState({ bindings: {} });
  ensureComputeContext({
    contextId,
    environmentId,
    cwd: "/project",
    ownerKey: "owner",
  });
  useComputeContextStore.getState().reserveSession({ sessionId, contextId });
  useComputeContextStore.getState().bindSession({
    contextId,
    sessionId,
    generation: ComputeSessionGeneration.make(1),
  });
});

describe("compute context close coordinator", () => {
  it("does not replace a newer observed session with a stale exact-id cache", () => {
    const earlier = { ...record(1, "ready"), lastActivityAt: "2026-09-10T00:00:00Z" };
    const later = {
      ...record(1, "ready"),
      lastActivityAt: "2026-09-10T00:01:00Z",
      activity: "busy" as const,
    };
    expect(mergeComputeSessionRecords([later], [earlier])).toEqual([later]);
    const stopped = { ...later, status: "stopped" as const };
    expect(mergeComputeSessionRecords([stopped], [later])).toEqual([stopped]);
    expect(mergeComputeSessionRecords([record(2, "ready")], [stopped])[0]?.generation).toBe(2);
  });
  it("re-reads the same owner after a generation race and retries stop once", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("stale generation")) })
      .mockResolvedValueOnce({ _tag: "Success", value: record(2, "stopped") });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(2, "ready") });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result).toEqual({ closed: true, contextId, error: null });
    expect(stopSession.mock.calls.map(([input]) => input.input.expectedGeneration)).toEqual([1, 2]);
    expect(getSession).toHaveBeenCalledWith({
      environmentId,
      input: { cwd: "/project", sessionId },
    });
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("keeps a failed close reachable for retry", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValue({ _tag: "Failure", cause: Cause.fail(new Error("shutdown failed")) });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: record(1, "ready") });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(false);
    expect(useComputeContextStore.getState().bindings[contextId]).toMatchObject({
      lifecycle: "close-failed",
      closeError: expect.any(String),
    });
  });

  it("does not trust a successful stop for another session", async () => {
    const stopSession = vi
      .fn()
      .mockResolvedValue({ _tag: "Success", value: record(1, "stopped", otherSessionId) });
    const getSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "stopped"),
    });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(true);
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("requires a terminal record even when stop reports success", async () => {
    const stopSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "ready"),
    });
    const getSession = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: record(1, "stopped"),
    });

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result.closed).toBe(true);
    expect(getSession).toHaveBeenCalledOnce();
    expect(useComputeContextStore.getState().bindings[contextId]?.lifecycle).toBe("terminal");
  });

  it("catches rejected callbacks and leaves the exact owner retryable", async () => {
    const stopSession = vi.fn().mockRejectedValue(new Error("transport closed"));
    const getSession = vi.fn();

    const result = await closeComputeContext({ contextId, stopSession, getSession });

    expect(result).toEqual({
      closed: false,
      contextId,
      error: "transport closed",
    });
    expect(getSession).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[contextId]).toMatchObject({
      contextId,
      sessionId,
      lifecycle: "close-failed",
    });
  });

  it("keeps a pending owner for a late start after session-not-found", async () => {
    const pendingContextId = "context-pending" as typeof contextId;
    ensureComputeContext({
      contextId: pendingContextId,
      environmentId,
      cwd: "/project",
      ownerKey: "pending-owner",
    });
    const pendingSessionId = ComputeSessionId.make("session-pending");
    useComputeContextStore.getState().reserveSession({
      contextId: pendingContextId,
      sessionId: pendingSessionId,
    });

    const stopSession = vi
      .fn()
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("session-not-found")),
      })
      .mockResolvedValueOnce({
        _tag: "Success",
        value: record(1, "stopped", pendingSessionId),
      });
    const getSession = vi.fn().mockResolvedValue({ _tag: "Success", value: null });

    const firstClose = await closeComputeContext({
      contextId: pendingContextId,
      stopSession,
      getSession,
    });
    expect(firstClose.closed).toBe(false);
    expect(useComputeContextStore.getState().bindings[pendingContextId]).toMatchObject({
      contextId: pendingContextId,
      sessionId: pendingSessionId,
      lifecycle: "close-failed",
    });

    // The delayed start response must not reclaim an owner already closing.
    expect(
      useComputeContextStore.getState().bindSession({
        contextId: pendingContextId,
        sessionId: pendingSessionId,
        generation: ComputeSessionGeneration.make(1),
      }),
    ).toBe(false);

    const retry = await closeComputeContext({
      contextId: pendingContextId,
      stopSession,
      getSession,
    });
    expect(retry.closed).toBe(true);
    expect(stopSession.mock.calls.at(-1)?.[0]).toMatchObject({
      input: { sessionId: pendingSessionId },
    });
  });

  it("closes an explicitly released pre-admission reservation without stopping another session", async () => {
    const capacityContextId = "context-capacity" as typeof contextId;
    ensureComputeContext({
      contextId: capacityContextId,
      environmentId,
      cwd: "/project",
      ownerKey: "capacity-owner",
    });
    const capacitySessionId = ComputeSessionId.make("session-capacity");
    const capacityGeneration = ComputeSessionGeneration.make(1);
    useComputeContextStore.getState().reserveSession({
      contextId: capacityContextId,
      sessionId: capacitySessionId,
      generation: capacityGeneration,
    });
    expect(
      useComputeContextStore.getState().releasePendingReservation({
        contextId: capacityContextId,
        sessionId: capacitySessionId,
        generation: capacityGeneration,
      }),
    ).toBe(true);

    const stopSession = vi.fn();
    const getSession = vi.fn();
    const result = await closeComputeContext({
      contextId: capacityContextId,
      stopSession,
      getSession,
    });

    expect(result).toEqual({ closed: true, contextId: capacityContextId, error: null });
    expect(stopSession).not.toHaveBeenCalled();
    expect(getSession).not.toHaveBeenCalled();
  });
});
