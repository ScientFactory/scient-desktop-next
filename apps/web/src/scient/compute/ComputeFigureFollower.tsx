"use client";

import type {
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { PreviewStaticImageSurfaceDescriptor } from "~/previewStaticImageSurface";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";

import {
  latestComputeFigureSession,
  latestSuccessfulFigureExecution,
  reconcileComputeFigureTarget,
} from "./computeFigureFollowerModel";
import {
  parseComputeFigureSurfaceId,
  type ComputeFigureReference,
  type ComputeFigureRevision,
} from "./computeFigureReference";

interface FollowTarget {
  readonly artifact: PreviewStaticImageSurfaceDescriptor;
  readonly reference: Exclude<ComputeFigureReference, { readonly _tag: "snapshot" }>;
}

interface RuntimeCandidateGroup {
  readonly execution: ComputeExecutionRecord;
  readonly targets: ReadonlyArray<FollowTarget>;
}

function ComputeRuntimeFigureCandidate(props: {
  readonly candidate: RuntimeCandidateGroup;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly rehydrationToken: string | null;
  readonly session: ComputeSessionRecord;
  readonly onOutputs: (
    target: FollowTarget,
    session: ComputeSessionRecord,
    execution: ComputeExecutionRecord,
    outputs: ReadonlyArray<ComputeOutput>,
  ) => void;
}) {
  const outputs = useEnvironmentQuery(
    computeEnvironment.outputs({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: props.session.sessionId,
        executionId: props.candidate.execution.request.executionId,
      },
    }),
  );

  useEffect(() => {
    if (props.rehydrationToken !== null) outputs.refresh();
  }, [props.rehydrationToken]);

  useEffect(() => {
    if (outputs.data === null) return;
    for (const target of props.candidate.targets) {
      props.onOutputs(target, props.session, props.candidate.execution, outputs.data.outputs);
    }
  }, [outputs.data, props.candidate, props.onOutputs, props.session]);

  return null;
}

/**
 * Keeps open logical figure surfaces current. The actual right-panel tabs and
 * floating card are the lifecycle authority; writes below are passive and can
 * never reopen a surface the user closed.
 */
export function ComputeFigureFollower(props: {
  readonly artifacts: ReadonlyArray<PreviewStaticImageSurfaceDescriptor>;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
}) {
  const targets = useMemo<ReadonlyArray<FollowTarget>>(() => {
    const bySurfaceId = new Map<string, FollowTarget>();
    for (const artifact of props.artifacts) {
      const reference = parseComputeFigureSurfaceId(artifact.surfaceId);
      if (reference === null || reference._tag === "snapshot") continue;
      bySurfaceId.set(artifact.surfaceId, { artifact, reference });
    }
    return [...bySurfaceId.values()];
  }, [props.artifacts]);
  const following = targets.length > 0;
  const appliedRevisionsRef = useRef(new Map<string, ComputeFigureRevision>());

  useEffect(() => {
    const openSurfaceIds = new Set(targets.map((target) => target.artifact.surfaceId));
    for (const surfaceId of appliedRevisionsRef.current.keys()) {
      if (!openSurfaceIds.has(surfaceId)) appliedRevisionsRef.current.delete(surfaceId);
    }
  }, [targets]);

  const sessions = useEnvironmentQuery(
    following
      ? computeEnvironment.sessions({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        })
      : null,
  );
  const events = useEnvironmentQuery(
    following
      ? computeEnvironment.events({
          environmentId: props.environmentId,
          input: { cwd: props.cwd },
        })
      : null,
  );
  const latestSession = useMemo(() => {
    const byId = new Map<string, ComputeSessionRecord>();
    for (const session of sessions.data ?? []) byId.set(session.sessionId, session);
    for (const session of events.data?.sessions.values() ?? []) {
      byId.set(session.sessionId, session);
    }
    return latestComputeFigureSession([...byId.values()]);
  }, [events.data?.sessions, sessions.data]);
  const executions = useEnvironmentQuery(
    latestSession === null
      ? null
      : computeEnvironment.executions({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, sessionId: latestSession.sessionId, limit: 100 },
        }),
  );
  const latestSessionExecutions = useMemo(() => {
    if (latestSession === null) return [];
    const byId = new Map<string, ComputeExecutionRecord>();
    for (const execution of executions.data ?? []) {
      byId.set(execution.request.executionId, execution);
    }
    for (const execution of events.data?.executions.get(latestSession.sessionId)?.values() ?? []) {
      byId.set(execution.request.executionId, execution);
    }
    return [...byId.values()];
  }, [events.data?.executions, executions.data, latestSession]);
  const rehydrationToken = events.data?.observedGap
    ? `${events.data.observedGap.expected}:${events.data.observedGap.received}`
    : null;

  useEffect(() => {
    if (!events.data?.stale) return;
    sessions.refresh();
    executions.refresh();
    events.refresh();
  }, [events.data?.stale]);

  const applyCandidate = useCallback(
    (
      target: FollowTarget,
      session: ComputeSessionRecord,
      execution: ComputeExecutionRecord,
      outputs: Parameters<typeof reconcileComputeFigureTarget>[0]["candidate"]["outputs"],
    ) => {
      const surfaceId = target.artifact.surfaceId;
      const decision = reconcileComputeFigureTarget({
        appliedRevision: appliedRevisionsRef.current.get(surfaceId) ?? null,
        artifact: target.artifact,
        cwd: props.cwd,
        reference: target.reference,
        candidate: { session, execution, outputs },
      });
      if (decision._tag === "unchanged") return;
      appliedRevisionsRef.current.set(surfaceId, decision.revision);
      useRightPanelStore.getState().updateScientArtifact(props.threadRef, decision.descriptor);
      usePreviewMiniPlayerStore.getState().updateArtifact(props.threadRef, decision.descriptor);
    },
    [props.cwd, props.threadRef],
  );

  const runtimeCandidateGroups = useMemo<ReadonlyArray<RuntimeCandidateGroup>>(() => {
    if (latestSession === null) return [];
    const byExecutionId = new Map<string, RuntimeCandidateGroup>();
    for (const target of targets) {
      if (target.reference._tag !== "runtime-display") continue;
      const execution = latestSuccessfulFigureExecution(
        target.reference,
        latestSession,
        latestSessionExecutions,
      );
      if (execution === null) continue;
      const executionId = execution.request.executionId;
      const current = byExecutionId.get(executionId);
      byExecutionId.set(executionId, {
        execution,
        targets: current === undefined ? [target] : [...current.targets, target],
      });
    }
    return [...byExecutionId.values()];
  }, [latestSession, latestSessionExecutions, targets]);

  useEffect(() => {
    if (events.data?.stale || latestSession === null) return;
    for (const target of targets) {
      if (target.reference._tag !== "project-file") continue;
      const execution = latestSuccessfulFigureExecution(
        target.reference,
        latestSession,
        latestSessionExecutions,
      );
      if (execution !== null) applyCandidate(target, latestSession, execution, null);
    }
  }, [applyCandidate, events.data?.stale, latestSession, latestSessionExecutions, targets]);

  if (events.data?.stale || latestSession === null) return null;
  return runtimeCandidateGroups.map((candidate) => (
    <ComputeRuntimeFigureCandidate
      key={candidate.execution.request.executionId}
      candidate={candidate}
      cwd={props.cwd}
      environmentId={props.environmentId}
      rehydrationToken={rehydrationToken}
      session={latestSession}
      onOutputs={applyCandidate}
    />
  ));
}
