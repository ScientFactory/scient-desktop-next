import { describe, expect, it } from "vite-plus/test";
import {
  ComputeExecutionId,
  type ComputeExecutionRecord,
  ComputeLanguageId,
  type ComputeOutput,
  ComputeProjectId,
  ComputeSessionGeneration,
  type ComputeSessionRecord,
  ComputeSessionId,
  INITIAL_COMPUTE_SESSION_GENERATION,
} from "@t3tools/contracts";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";

import {
  computeFigureRevision,
  latestComputeFigureSession,
  latestSuccessfulFigureExecution,
  reconcileComputeFigureTarget,
} from "./computeFigureFollowerModel";
import { computeFigureSurfaceId, type ComputeFigureReference } from "./computeFigureReference";

const projectId = ComputeProjectId.make("project-1");
const sessionId = ComputeSessionId.make("session-1");
const languageId = ComputeLanguageId.make("python");
const hash = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}` as const;

const session = {
  projectId,
  sessionId,
  languageId,
  generation: INITIAL_COMPUTE_SESSION_GENERATION,
  createdAt: "2026-08-21T00:00:00.000Z",
} as ComputeSessionRecord;

const runtimeReference: ComputeFigureReference = {
  _tag: "runtime-display",
  projectId,
  sessionId,
  languageId,
  path: "analysis.py",
  ordinal: 1,
};

function execution(
  id: string,
  submittedAt: string,
  status: "succeeded" | "failed" | "cancelled" | "lost" = "succeeded",
  executionSessionId = sessionId,
  generation: ComputeSessionGeneration = INITIAL_COMPUTE_SESSION_GENERATION,
): ComputeExecutionRecord {
  return {
    request: {
      executionId: ComputeExecutionId.make(id),
      sessionId: executionSessionId,
      generation,
      submittedAt,
      source: {
        _tag: "document",
        origin: "file",
        path: "analysis.py",
        bufferState: "saved",
      },
    },
    result: { status },
  } as ComputeExecutionRecord;
}

function image(seed: string): Extract<ComputeOutput, { readonly _tag: "image" }> {
  return {
    _tag: "image",
    sequence: 1,
    observedAt: "2026-08-21T00:00:00.000Z",
    mediaType: "image/png",
    contentHash: hash(seed),
    byteLength: 10,
    width: null,
    height: null,
    origin: { _tag: "runtime-display" },
  };
}

const artifact: PreviewStaticImageSurfaceDescriptor = {
  surfaceId: computeFigureSurfaceId(runtimeReference),
  label: "Figure 1",
  fileName: "figure-1.png",
  mediaType: "image/png",
  sourcePath: "analysis.py",
  contentKey: hash("a"),
  resource: {
    _tag: "compute-output",
    projectId,
    sessionId,
    executionId: ComputeExecutionId.make("initial"),
    contentHash: hash("a"),
  },
};

describe("compute figure follow reconciliation", () => {
  it("selects the newest session independently of query arrival order", () => {
    const newerSession = {
      ...session,
      sessionId: ComputeSessionId.make("session-2"),
      createdAt: "2026-08-22T00:00:00.000Z",
    };
    expect(latestComputeFigureSession([newerSession, session])?.sessionId).toBe(
      newerSession.sessionId,
    );
    expect(latestComputeFigureSession([session, newerSession])?.sessionId).toBe(
      newerSession.sessionId,
    );
  });

  it("selects a deterministic latest execution when timestamps tie", () => {
    const first = execution("execution-a", "2026-08-21T00:01:00.000Z");
    const second = execution("execution-b", "2026-08-21T00:01:00.000Z");
    expect(
      latestSuccessfulFigureExecution(runtimeReference, session, [first, second])?.request
        .executionId,
    ).toBe(second.request.executionId);
    expect(
      latestSuccessfulFigureExecution(runtimeReference, session, [second, first])?.request
        .executionId,
    ).toBe(second.request.executionId);
  });

  it("updates matching runtime output under one stable surface identity", () => {
    const nextExecution = execution("next", "2026-08-21T00:01:00.000Z");
    const decision = reconcileComputeFigureTarget({
      appliedRevision: null,
      artifact,
      cwd: "/project",
      reference: runtimeReference,
      candidate: {
        session,
        execution: nextExecution,
        outputs: [image("b")],
      },
    });
    expect(decision._tag).toBe("apply");
    if (decision._tag !== "apply") return;
    expect(decision.descriptor.surfaceId).toBe(artifact.surfaceId);
    expect(decision.descriptor.contentKey).toBe(hash("b"));
    expect(decision.descriptor.statusLabel).toBeUndefined();
  });

  it("keeps failed output unchanged and labels a successful missing display", () => {
    const failed = reconcileComputeFigureTarget({
      appliedRevision: null,
      artifact,
      cwd: "/project",
      reference: runtimeReference,
      candidate: {
        session,
        execution: execution("failed", "2026-08-21T00:01:00.000Z", "failed"),
        outputs: [],
      },
    });
    expect(failed).toEqual({ _tag: "unchanged" });
    for (const status of ["cancelled", "lost"] as const) {
      expect(
        reconcileComputeFigureTarget({
          appliedRevision: null,
          artifact,
          cwd: "/project",
          reference: runtimeReference,
          candidate: {
            session,
            execution: execution(status, "2026-08-21T00:01:30.000Z", status),
            outputs: [image("b")],
          },
        }),
      ).toEqual({ _tag: "unchanged" });
    }

    const missing = reconcileComputeFigureTarget({
      appliedRevision: null,
      artifact,
      cwd: "/project",
      reference: runtimeReference,
      candidate: {
        session,
        execution: execution("missing", "2026-08-21T00:02:00.000Z"),
        outputs: [],
      },
    });
    expect(missing._tag).toBe("apply");
    if (missing._tag === "apply") {
      expect(missing.descriptor.resource).toEqual(artifact.resource);
      expect(missing.descriptor.statusLabel).toBe("Previous figure");
    }
  });

  it("refreshes project-file authority without coupling it to one producer", () => {
    const reference: ComputeFigureReference = {
      _tag: "project-file",
      projectId,
      path: "results/figure.svg",
    };
    const projectArtifact = {
      ...artifact,
      surfaceId: computeFigureSurfaceId(reference),
      label: "figure.svg",
      fileName: "figure.svg",
      mediaType: "image/svg+xml" as const,
      sourcePath: reference.path,
    };
    const nextExecution = execution("next", "2026-08-21T00:03:00.000Z");
    const decision = reconcileComputeFigureTarget({
      appliedRevision: null,
      artifact: projectArtifact,
      cwd: "/project",
      reference,
      candidate: { session, execution: nextExecution, outputs: null },
    });
    expect(decision._tag).toBe("apply");
    if (decision._tag !== "apply") return;
    expect(decision.descriptor.resource).toEqual({
      _tag: "workspace-file",
      cwd: "/project",
      relativePath: "results/figure.svg",
    });
    expect(decision.descriptor.statusLabel).toBe("Observed project file");
  });

  it("rejects 20,000 late older completions after a newer revision", () => {
    const newest = execution("newest", "2026-08-21T23:59:59.000Z");
    const applied = computeFigureRevision(session, newest);
    for (let index = 0; index < 20_000; index += 1) {
      const late = execution(
        `late-${String(index).padStart(5, "0")}`,
        `2026-08-21T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`,
      );
      expect(
        reconcileComputeFigureTarget({
          appliedRevision: applied,
          artifact,
          cwd: "/project",
          reference: runtimeReference,
          candidate: { session, execution: late, outputs: [image("z")] },
        }),
      ).toEqual({ _tag: "unchanged" });
    }
  });

  it("follows a restart of the same session and rejects late older generations", () => {
    const restartedSession = {
      ...session,
      generation: ComputeSessionGeneration.make(2),
    };
    // Generation ordering wins even if the wall clock moves backwards on restart.
    const previousExecution = execution("previous", "2026-08-22T00:02:00.000Z");
    const restartedExecution = execution(
      "restart-execution",
      "2026-08-22T00:01:00.000Z",
      "succeeded",
      sessionId,
      ComputeSessionGeneration.make(2),
    );
    for (const executions of [
      [previousExecution, restartedExecution],
      [restartedExecution, previousExecution],
    ]) {
      expect(latestSuccessfulFigureExecution(runtimeReference, restartedSession, executions)).toBe(
        restartedExecution,
      );
    }
    const applied = reconcileComputeFigureTarget({
      appliedRevision: computeFigureRevision(session, previousExecution),
      artifact,
      cwd: "/project",
      reference: runtimeReference,
      candidate: {
        session: restartedSession,
        execution: restartedExecution,
        outputs: [image("restart")],
      },
    });
    expect(applied._tag).toBe("apply");
    if (applied._tag !== "apply") return;
    expect(applied.revision.generation).toBe(ComputeSessionGeneration.make(2));
    expect(applied.descriptor.surfaceId).toBe(artifact.surfaceId);
    expect(applied.descriptor.resource).toMatchObject({
      sessionId,
      executionId: restartedExecution.request.executionId,
      contentHash: hash("restart"),
    });
    expect(
      reconcileComputeFigureTarget({
        appliedRevision: applied.revision,
        artifact: applied.descriptor,
        cwd: "/project",
        reference: runtimeReference,
        candidate: {
          session: restartedSession,
          execution: previousExecution,
          outputs: [image("old")],
        },
      }),
    ).toEqual({ _tag: "unchanged" });
  });

  it("keeps historical snapshots immutable across restarts and new sessions", () => {
    const reference: ComputeFigureReference = {
      _tag: "snapshot",
      projectId,
      sessionId,
      executionId: ComputeExecutionId.make("initial"),
      contentHash: hash("a"),
    };
    const snapshot = { ...artifact, surfaceId: computeFigureSurfaceId(reference) };
    for (const candidateSession of [
      { ...session, generation: ComputeSessionGeneration.make(2) },
      { ...session, sessionId: ComputeSessionId.make("new-session") },
    ]) {
      const candidateExecution = execution(
        "next",
        "2026-08-22T00:01:00.000Z",
        "succeeded",
        candidateSession.sessionId,
        candidateSession.generation,
      );
      expect(
        latestSuccessfulFigureExecution(reference, candidateSession, [candidateExecution]),
      ).toBeNull();
      expect(
        reconcileComputeFigureTarget({
          appliedRevision: null,
          artifact: snapshot,
          cwd: "/project",
          reference,
          candidate: {
            session: candidateSession,
            execution: candidateExecution,
            outputs: [image("next")],
          },
        }),
      ).toEqual({ _tag: "unchanged" });
    }
  });

  it("rehydrates from the referenced session without following a newer same-file session", () => {
    const newerSession = {
      ...session,
      sessionId: ComputeSessionId.make("session-2"),
      createdAt: "2026-08-22T00:00:00.000Z",
    };
    const newerReference: ComputeFigureReference = {
      ...runtimeReference,
      sessionId: newerSession.sessionId,
    };
    const newerArtifact = {
      ...artifact,
      surfaceId: computeFigureSurfaceId(newerReference),
      resource: {
        ...artifact.resource,
        sessionId: newerSession.sessionId,
      },
    };
    const newerExecution = execution(
      "new-session-execution",
      "2026-08-22T00:01:00.000Z",
      "succeeded",
      newerSession.sessionId,
    );
    const originalExecution = execution("original-session", "2026-08-21T00:01:00.000Z");
    expect(latestSuccessfulFigureExecution(runtimeReference, session, [newerExecution])).toBeNull();
    for (const executions of [
      [originalExecution, newerExecution],
      [newerExecution, originalExecution],
    ]) {
      expect(latestSuccessfulFigureExecution(runtimeReference, session, executions)).toBe(
        originalExecution,
      );
      expect(latestSuccessfulFigureExecution(newerReference, newerSession, executions)).toBe(
        newerExecution,
      );
    }
    expect(
      reconcileComputeFigureTarget({
        appliedRevision: null,
        artifact,
        cwd: "/project",
        reference: runtimeReference,
        candidate: {
          session: newerSession,
          execution: newerExecution,
          outputs: [image("wrong-session")],
        },
      }),
    ).toEqual({ _tag: "unchanged" });
    const rehydrated = reconcileComputeFigureTarget({
      appliedRevision: null,
      artifact: newerArtifact,
      cwd: "/project",
      reference: newerReference,
      candidate: {
        session: newerSession,
        execution: newerExecution,
        outputs: [image("n")],
      },
    });
    expect(rehydrated._tag).toBe("apply");
    if (rehydrated._tag !== "apply") return;
    expect(rehydrated.descriptor.resource).toMatchObject({
      _tag: "compute-output",
      sessionId: newerSession.sessionId,
      executionId: newerExecution.request.executionId,
    });

    const olderExecution = execution("late-old-session", "2026-08-21T23:59:59.000Z");
    expect(
      reconcileComputeFigureTarget({
        appliedRevision: rehydrated.revision,
        artifact: rehydrated.descriptor,
        cwd: "/project",
        reference: newerReference,
        candidate: { session, execution: olderExecution, outputs: [image("o")] },
      }),
    ).toEqual({ _tag: "unchanged" });
  });
});
