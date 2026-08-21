import { describe, expect, it } from "vite-plus/test";
import {
  ComputeExecutionId,
  ComputeLanguageId,
  ComputeProjectId,
  ComputeSessionId,
  ComputeTransportKind,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeExecutionRecord,
  type ComputeSessionRecord,
  type ComputeSessionStreamEvent,
} from "@t3tools/contracts";

import { applyComputeSessionStreamEvent, EMPTY_COMPUTE_SUBSCRIPTION_STATE } from "./compute.ts";

const PROJECT = ComputeProjectId.make("project-1");
const PYTHON = ComputeLanguageId.make("python");
const TRANSPORT = ComputeTransportKind.make("jupyter-bridge");
const NOW = "2026-08-20T12:00:00.000Z";

function session(id: string, status: ComputeSessionRecord["status"] = "ready") {
  return {
    sessionId: ComputeSessionId.make(id),
    projectId: PROJECT,
    label: "Python",
    languageId: PYTHON,
    transportKind: TRANSPORT,
    workingDirectory: "/project",
    runtime: null,
    identity: null,
    environmentFingerprint: null,
    generation: INITIAL_COMPUTE_SESSION_GENERATION,
    status,
    activity: "idle",
    activeExecutionId: null,
    pendingCount: 0,
    storage: {
      status: "retained",
      outputBytes: 0,
      imageBytes: 0,
      totalBytes: 0,
      removedAt: null,
    },
    createdAt: NOW,
    lastActivityAt: NOW,
    closedAt: status === "ready" ? null : NOW,
    lostReason: null,
  } satisfies ComputeSessionRecord;
}

function execution(id: string): ComputeExecutionRecord {
  const executionId = ComputeExecutionId.make(id);
  return {
    request: {
      executionId,
      sessionId: ComputeSessionId.make("session-1"),
      generation: INITIAL_COMPUTE_SESSION_GENERATION,
      code: "1 + 1",
      codeHash: `sha256:${"0".repeat(64)}`,
      source: { _tag: "console" },
      submittedAt: NOW,
      environmentFingerprint: null,
    },
    result: {
      executionId,
      status: "succeeded",
      outcome: "succeeded",
      queuePosition: null,
      startedAt: NOW,
      finishedAt: NOW,
      diagnostics: [],
      outputCount: 0,
      imageCount: 0,
      outputBytes: 0,
      truncated: false,
      failureReason: null,
    },
  };
}

function fold(events: ReadonlyArray<ComputeSessionStreamEvent>) {
  return events.reduce(applyComputeSessionStreamEvent, EMPTY_COMPUTE_SUBSCRIPTION_STATE);
}

describe("compute live projection", () => {
  it("accepts a multi-session snapshot boundary and ignores duplicate deltas", () => {
    const snapshotA: ComputeSessionStreamEvent = {
      _tag: "session-snapshot",
      eventSequence: 7,
      session: session("session-1"),
    };
    const snapshotB: ComputeSessionStreamEvent = {
      _tag: "session-snapshot",
      eventSequence: 7,
      session: session("session-2", "stopped"),
    };
    const live: ComputeSessionStreamEvent = {
      _tag: "session-updated",
      eventSequence: 7,
      session: { ...session("session-1"), activity: "busy" },
    };
    const afterLive = fold([snapshotA, snapshotB, live]);
    expect(afterLive.sessions.size).toBe(2);
    expect(afterLive.expectedLiveSequence).toBe(8);
    expect(afterLive.sessions.get("session-1")?.activity).toBe("busy");

    const duplicate = applyComputeSessionStreamEvent(afterLive, live);
    expect(duplicate).toBe(afterLive);
  });

  it("freezes deltas after a gap until a new subscription snapshot replaces it", () => {
    const initial = fold([
      { _tag: "session-snapshot", eventSequence: 3, session: session("session-1") },
    ]);
    const gap = applyComputeSessionStreamEvent(initial, {
      _tag: "session-updated",
      eventSequence: 5,
      session: { ...session("session-1"), activity: "busy" },
    });
    expect(gap.stale).toBe(true);
    expect(gap.observedGap).toEqual({ expected: 3, received: 5 });
    expect(
      applyComputeSessionStreamEvent(gap, {
        _tag: "session-updated",
        eventSequence: 6,
        session: { ...session("session-1"), activity: "busy" },
      }),
    ).toBe(gap);
  });

  it("keeps session messages separate from execution output", () => {
    const state = fold([
      { _tag: "session-snapshot", eventSequence: 4, session: session("session-1") },
      {
        _tag: "execution-output",
        eventSequence: 4,
        projectId: PROJECT,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: null,
        outputs: [
          {
            _tag: "system",
            sequence: 1,
            observedAt: NOW,
            event: "runtime-warning",
            detail: "bridge notice",
          },
        ],
      },
      {
        _tag: "execution-output",
        eventSequence: 5,
        projectId: PROJECT,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-1"),
        outputs: [
          {
            _tag: "stream",
            sequence: 2,
            observedAt: NOW,
            stream: "stdout",
            text: "result",
          },
        ],
      },
    ]);

    expect(state.outputs.get("session-1/@session")?.outputs[0]?._tag).toBe("system");
    expect(state.outputs.get("session-1/execution-1")?.outputs[0]?._tag).toBe("stream");
  });

  it("bounds terminal history, execution projections, and output flood memory", () => {
    let state = EMPTY_COMPUTE_SUBSCRIPTION_STATE;
    for (let index = 0; index < 40; index += 1) {
      const sessionId = ComputeSessionId.make(`old-${index}`);
      state = applyComputeSessionStreamEvent(state, {
        _tag: "session-snapshot",
        eventSequence: 0,
        session: {
          ...session(sessionId, "stopped"),
          createdAt: `2026-08-20T12:00:${String(index).padStart(2, "0")}.000Z`,
        },
      });
      state = {
        ...state,
        executions: new Map(state.executions).set(sessionId, new Map()),
      };
    }
    expect(state.sessions.size).toBe(32);

    state = applyComputeSessionStreamEvent(state, {
      _tag: "session-snapshot",
      eventSequence: 0,
      session: session("old-39", "stopped"),
    });
    expect(state.executions.size).toBe(32);
    expect(state.executions.has("old-0")).toBe(false);

    state = applyComputeSessionStreamEvent(state, {
      _tag: "session-snapshot",
      eventSequence: 0,
      session: session("session-1"),
    });
    for (let index = 0; index < 140; index += 1) {
      state = applyComputeSessionStreamEvent(state, {
        _tag: "execution-updated",
        eventSequence: index,
        projectId: PROJECT,
        sessionId: ComputeSessionId.make("session-1"),
        execution: execution(`execution-${index}`),
      });
    }
    expect(state.executions.get("session-1")?.size).toBe(100);

    state = applyComputeSessionStreamEvent(state, {
      _tag: "execution-output",
      eventSequence: 140,
      projectId: PROJECT,
      sessionId: ComputeSessionId.make("session-1"),
      executionId: ComputeExecutionId.make("execution-current"),
      outputs: [
        {
          _tag: "image",
          sequence: 0,
          observedAt: NOW,
          mediaType: "image/png",
          contentHash: `sha256:${"a".repeat(64)}`,
          byteLength: 8,
          width: 1,
          height: 1,
        },
      ],
    });
    for (let index = 141; index < 441; index += 1) {
      state = applyComputeSessionStreamEvent(state, {
        _tag: "execution-output",
        eventSequence: index,
        projectId: PROJECT,
        sessionId: ComputeSessionId.make("session-1"),
        executionId: ComputeExecutionId.make("execution-current"),
        outputs: [
          {
            _tag: "stream",
            sequence: index,
            observedAt: NOW,
            stream: "stdout",
            text: "x".repeat(10_000),
          },
        ],
      });
    }
    const output = state.outputs.get("session-1/execution-current");
    expect(output?.clipped).toBe(true);
    expect(output?.outputs.length).toBeLessThanOrEqual(256);
    expect(output?.bytes).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(output?.outputs.some((item) => item._tag === "image")).toBe(false);
    expect(output?.hasImage).toBe(true);
  });
});
