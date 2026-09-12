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
  const outputData = outputs.data;
  const refreshOutputs = outputs.refresh;
  const candidate = props.candidate;
  const onOutputs = props.onOutputs;
  const session = props.session;

  useEffect(() => {
    if (props.rehydrationToken !== null) refreshOutputs();
  }, [props.rehydrationToken, refreshOutputs]);

  useEffect(() => {
    if (outputData === null) return;
    for (const target of candidate.targets) {
      onOutputs(target, session, candidate.execution, outputData.outputs);
    }
  }, [candidate, onOutputs, outputData, session]);

  return null;
}

function ComputeRuntimeFigureSession(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly liveExecutions: ReadonlyArray<ComputeExecutionRecord>;
  readonly rehydrationToken: string | null;
  readonly sessionId: ComputeSessionRecord["sessionId"];
  readonly targets: ReadonlyArray<FollowTarget>;
  readonly onOutputs: (
    target: FollowTarget,
    session: ComputeSessionRecord,
    execution: ComputeExecutionRecord,
    outputs: ReadonlyArray<ComputeOutput>,
  ) => void;
}) {
  const sessionQuery = useEnvironmentQuery(
    computeEnvironment.session({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: props.sessionId,
      },
    }),
  );
  const session = sessionQuery.data;
  const executions = useEnvironmentQuery(
    computeEnvironment.executions({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, sessionId: props.sessionId, limit: 100 },
    }),
  );
  const executionData = executions.data;
  const refreshExecutions = executions.refresh;
  const sessionExecutions = useMemo(() => {
    const byId = new Map<string, ComputeExecutionRecord>();
    for (const execution of executionData ?? []) byId.set(execution.request.executionId, execution);
    for (const execution of props.liveExecutions) {
      byId.set(execution.request.executionId, execution);
    }
    return [...byId.values()];
  }, [executionData, props.liveExecutions]);

  useEffect(() => {
    if (props.rehydrationToken !== null) refreshExecutions();
  }, [props.rehydrationToken, refreshExecutions]);

  const runtimeCandidateGroups = useMemo<ReadonlyArray<RuntimeCandidateGroup>>(() => {
    if (session === null) return [];
    const byExecutionId = new Map<string, RuntimeCandidateGroup>();
    for (const target of props.targets) {
      const execution = latestSuccessfulFigureExecution(
        target.reference,
        session,
        sessionExecutions,
      );
      if (execution === null) continue;
      const key = execution.request.executionId;
      const current = byExecutionId.get(key);
      byExecutionId.set(key, {
        execution,
        targets: current === undefined ? [target] : [...current.targets, target],
      });
    }
    return [...byExecutionId.values()];
  }, [props.targets, session, sessionExecutions]);

  if (session === null) return null;
  return runtimeCandidateGroups.map((candidate) => (
    <ComputeRuntimeFigureCandidate
      key={candidate.execution.request.executionId}
      candidate={candidate}
      cwd={props.cwd}
      environmentId={props.environmentId}
      rehydrationToken={props.rehydrationToken}
      session={session}
      onOutputs={props.onOutputs}
    />
  ));
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
  const followingProjectFiles = targets.some((target) => target.reference._tag === "project-file");
  const appliedRevisionsRef = useRef(new Map<string, ComputeFigureRevision>());

  useEffect(() => {
    const openSurfaceIds = new Set(targets.map((target) => target.artifact.surfaceId));
    for (const surfaceId of appliedRevisionsRef.current.keys()) {
      if (!openSurfaceIds.has(surfaceId)) appliedRevisionsRef.current.delete(surfaceId);
    }
  }, [targets]);

  const sessions = useEnvironmentQuery(
    followingProjectFiles
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
    if (!followingProjectFiles) return null;
    const byId = new Map<string, ComputeSessionRecord>();
    for (const session of sessions.data ?? []) byId.set(session.sessionId, session);
    for (const session of events.data?.sessions.values() ?? []) {
      byId.set(session.sessionId, session);
    }
    return latestComputeFigureSession([...byId.values()]);
  }, [events.data?.sessions, followingProjectFiles, sessions.data]);
  const executions = useEnvironmentQuery(
    latestSession === null
      ? null
      : computeEnvironment.executions({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, sessionId: latestSession.sessionId, limit: 100 },
        }),
  );
  const refreshSessions = sessions.refresh;
  const refreshLatestExecutions = executions.refresh;
  const refreshEvents = events.refresh;
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
  const runtimeSessionTargets = useMemo(() => {
    const bySessionId = new Map<ComputeSessionRecord["sessionId"], FollowTarget[]>();
    for (const target of targets) {
      if (target.reference._tag !== "runtime-display") {
        continue;
      }
      const sessionTargets = bySessionId.get(target.reference.sessionId) ?? [];
      sessionTargets.push(target);
      bySessionId.set(target.reference.sessionId, sessionTargets);
    }
    return [...bySessionId.entries()].map(([sessionId, sessionTargets]) => ({
      liveExecutions: [...(events.data?.executions.get(sessionId)?.values() ?? [])],
      sessionId,
      targets: sessionTargets,
    }));
  }, [events.data?.executions, targets]);
  const rehydrationToken = events.data?.observedGap
    ? `${events.data.observedGap.expected}:${events.data.observedGap.received}`
    : null;

  useEffect(() => {
    if (!events.data?.stale) return;
    refreshSessions();
    refreshLatestExecutions();
    refreshEvents();
  }, [events.data?.stale, refreshEvents, refreshLatestExecutions, refreshSessions]);

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

  if (events.data?.stale) return null;
  return runtimeSessionTargets.map(({ liveExecutions, sessionId, targets: sessionTargets }) => (
    <ComputeRuntimeFigureSession
      key={sessionId}
      cwd={props.cwd}
      environmentId={props.environmentId}
      sessionId={sessionId}
      liveExecutions={liveExecutions}
      rehydrationToken={rehydrationToken}
      targets={sessionTargets}
      onOutputs={applyCandidate}
    />
  ));
}
