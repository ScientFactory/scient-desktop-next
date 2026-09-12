import type { ComputeSessionRecord, EnvironmentId } from "@t3tools/contracts";
import {
  ComputeExecutionId,
  ComputeSessionId,
  TERMINAL_COMPUTE_SESSION_STATUSES,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDown, LoaderCircle, Play, RefreshCwIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";

import {
  computeCell,
  computeFile,
  computeLineSelection,
  resolveComputeRunTarget,
  type ComputeCodeSlice,
  type ComputeTextRange,
} from "./computeSourceSlices";
import { closeComputeContext, mergeComputeSessionRecords } from "./computeContextCoordinator";
import {
  defaultComputeRuntime,
  isComputeCapacityReachedError,
  resolveComputeRuntimeToolbarState,
} from "./computeFileSurfaceModel";
import {
  computeSessionOwnerLabel,
  ensureComputeContext,
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  ownsLiveComputeSession,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";

import type { ComputeSourceLanguage } from "./computeSourceLanguage";

type ComputeRunKind = "selection" | "cell" | "file";

export interface ComputeFileActionsHandle {
  readonly runPrimary: (selection?: ComputeTextRange | null) => void;
  readonly runCellAtLine: (line: number) => void;
}

interface ComputeFileActionsProps {
  readonly language: ComputeSourceLanguage;
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly editorSelection: ComputeTextRange | null;
  readonly contextId?: ComputeContextId;
  readonly onRunRequested: () => void;
  readonly onExecutionSubmitted: (
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId,
  ) => void;
}

function reportFailure(
  title: string,
  result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
) {
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The compute operation failed.",
    }),
  );
}

export const ComputeFileActions = forwardRef<ComputeFileActionsHandle, ComputeFileActionsProps>(
  function ComputeFileActions(props, ref) {
    const onRunRequested = props.onRunRequested;
    const [operation, setOperation] = useState<ComputeRunKind | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [stoppingUnusedSession, setStoppingUnusedSession] = useState<ComputeSessionId | null>(
      null,
    );
    const [capacityBlocked, setCapacityBlocked] = useState(false);
    const [startRetryAvailable, setStartRetryAvailable] = useState(false);
    const [switchTarget, setSwitchTarget] = useState<{
      readonly environmentId: EnvironmentId;
      readonly session: ComputeSessionRecord;
    } | null>(null);
    const contextBinding = useComputeContextStore((state) =>
      props.contextId === undefined ? null : (state.bindings[props.contextId] ?? null),
    );
    const sessions = useEnvironmentQuery(
      computeEnvironment.sessions({
        environmentId: props.environmentId,
        input: { cwd: props.cwd },
      }),
    );
    const events = useEnvironmentQuery(
      computeEnvironment.events({
        environmentId: props.environmentId,
        input: { cwd: props.cwd },
      }),
    );
    const runtimes = useEnvironmentQuery(
      computeEnvironment.runtimes({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, refresh: false },
      }),
    );
    const exactSessionQuery =
      props.contextId !== undefined &&
      contextBinding?.sessionId !== null &&
      contextBinding?.sessionId !== undefined &&
      typeof computeEnvironment.session === "function"
        ? computeEnvironment.session({
            environmentId: props.environmentId,
            input: { cwd: props.cwd, sessionId: contextBinding.sessionId },
          })
        : null;
    const exactSession = useEnvironmentQuery(exactSessionQuery);
    const refreshSessions = sessions.refresh;
    const refreshEvents = events.refresh;
    const refreshRuntimeInspection = runtimes.refresh;
    const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
    const submitExecution = useAtomCommand(computeEnvironment.submitExecution, {
      reportFailure: false,
    });
    const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes, {
      reportFailure: false,
    });
    const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
    const getSession = useAtomQueryRunner(computeEnvironment.session, {
      reportFailure: false,
      refresh: true,
    });
    const confirmFailedStart = useCallback(
      async (sessionId: ComputeSessionId, generation: ComputeSessionRecord["generation"]) => {
        if (props.contextId === undefined || typeof computeEnvironment.session !== "function")
          return;
        try {
          const observed = await getSession({
            environmentId: props.environmentId,
            input: { cwd: props.cwd, sessionId },
          });
          if (
            observed._tag !== "Success" ||
            observed.value === null ||
            observed.value.sessionId !== sessionId ||
            observed.value.generation !== generation ||
            !TERMINAL_COMPUTE_SESSION_STATUSES.has(observed.value.status)
          ) {
            return;
          }
          useComputeContextStore.getState().markSessionTerminal({
            contextId: props.contextId,
            sessionId,
            generation,
          });
        } catch {
          // A rejected read is not proof that the independent server startup stopped.
        }
      },
      [getSession, props.contextId, props.cwd, props.environmentId],
    );

    const allSessions = useMemo(
      () =>
        mergeComputeSessionRecords(
          sessions.data ?? [],
          exactSession.data === null ? [] : [exactSession.data],
          events.data?.sessions.values() ?? [],
        ),
      [events.data?.sessions, exactSession.data, sessions.data],
    );
    const ownedSession = allSessions.find(
      (session) => session.sessionId === contextBinding?.sessionId,
    );
    useEffect(() => {
      if (props.contextId !== undefined && ownedSession !== undefined) {
        useComputeContextStore.getState().observeSession(props.contextId, ownedSession);
      }
    }, [props.contextId, ownedSession]);
    const canRetryStart =
      startRetryAvailable || (contextBinding?.lifecycle === "starting" && operation === null);
    const capacitySessions = useMemo(
      () =>
        allSessions.filter(
          (session) =>
            !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) &&
            session.sessionId !== contextBinding?.sessionId,
        ),
      [allSessions, contextBinding?.sessionId],
    );
    const liveSession = useMemo(() => {
      if (props.contextId !== undefined) {
        if (contextBinding?.sessionId === null || contextBinding?.sessionId === undefined) {
          return null;
        }
        return (
          allSessions.find(
            (session) =>
              session.sessionId === contextBinding.sessionId &&
              !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
          ) ?? null
        );
      }
      return (
        allSessions.find((session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status)) ??
        null
      );
    }, [allSessions, contextBinding?.sessionId, props.contextId]);
    const readyRuntime = useMemo(
      () =>
        defaultComputeRuntime(
          runtimes.data?.languages.filter(
            (language) => language.descriptor.languageId === props.language.languageId,
          ) ?? [],
        ),
      [runtimes.data, props.language.languageId],
    );
    const activeRuntime =
      liveSession === null || liveSession.runtime === null
        ? readyRuntime
        : (runtimes.data?.languages
            .find((language) => language.descriptor.languageId === props.language.languageId)
            ?.runtimes.find(
              (candidate) => candidate.profile.executable === liveSession.runtime?.executable,
            ) ?? null);
    const scientificToolkit = activeRuntime?.toolkits.find(
      (toolkit) => toolkit.toolkitId === "python-data-and-figures",
    );
    const missingScientificPackages =
      scientificToolkit?.readiness === "missing-requirement"
        ? scientificToolkit.missingRequirements
        : [];
    const runtimeToolbar = resolveComputeRuntimeToolbarState({
      languageId: props.language.languageId,
      languageName: props.language.displayName,
      liveSession,
      runtimeInspectionPending: runtimes.isPending || refreshing,
      readyRuntimeAvailable: readyRuntime !== null,
      preferredRuntimeExecutable: readyRuntime?.profile.executable ?? null,
      scientificPackagesMissing: missingScientificPackages.length > 0,
      capacityRecoveryAvailable: capacityBlocked,
      startingRetryAvailable: canRetryStart,
      ...(contextBinding?.lifecycle === undefined
        ? {}
        : { contextLifecycle: contextBinding.lifecycle }),
    });
    const requestRuntimeSwitch = () => {
      if (liveSession !== null) {
        setSwitchTarget({ environmentId: props.environmentId, session: liveSession });
      }
    };

    const stopUnusedSession = useCallback(
      async (session: ComputeSessionRecord) => {
        if (stoppingUnusedSession !== null) return;
        setStoppingUnusedSession(session.sessionId);
        let result: Awaited<ReturnType<typeof stopSession>>;
        try {
          result = await stopSession({
            environmentId: props.environmentId,
            input: {
              cwd: props.cwd,
              sessionId: session.sessionId,
              expectedGeneration: session.generation,
            },
          });
        } catch (error) {
          setStoppingUnusedSession(null);
          toastManager.add({
            type: "error",
            title: `Unable to stop ${session.label}`,
            description: error instanceof Error ? error.message : "The stop request failed.",
          });
          return;
        }
        setStoppingUnusedSession(null);
        if (result._tag === "Success") {
          for (const binding of Object.values(useComputeContextStore.getState().bindings)) {
            if (
              binding.environmentId === props.environmentId &&
              binding.cwd === props.cwd &&
              binding.sessionId === session.sessionId &&
              binding.generation === session.generation
            ) {
              useComputeContextStore.getState().markSessionTerminal({
                contextId: binding.contextId,
                sessionId: result.value.sessionId,
                generation: result.value.generation,
              });
            }
          }
          refreshSessions();
          refreshEvents();
          refreshRuntimeInspection();
          return;
        }
        if (!isAtomCommandInterrupted(result)) {
          reportFailure(`Unable to stop ${session.label}`, result);
        }
      },
      [
        props.cwd,
        props.environmentId,
        refreshEvents,
        refreshRuntimeInspection,
        refreshSessions,
        stopSession,
        stoppingUnusedSession,
      ],
    );

    const refreshRuntime = useCallback(async () => {
      if (refreshing) return;
      setRefreshing(true);
      const result = await refreshRuntimes({
        environmentId: props.environmentId,
        input: { cwd: props.cwd, refresh: true },
      });
      setRefreshing(false);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result))
          reportFailure(`Unable to refresh ${props.language.displayName}`, result);
        return;
      }
      refreshSessions();
    }, [
      props.cwd,
      props.environmentId,
      refreshRuntimes,
      refreshing,
      refreshSessions,
      props.language.displayName,
    ]);

    const switchRuntime = useCallback(async () => {
      if (switchTarget === null || switching) return;
      const target = switchTarget;
      setSwitching(true);
      const result = await stopSession({
        environmentId: target.environmentId,
        input: {
          cwd: target.session.workingDirectory,
          sessionId: target.session.sessionId,
          expectedGeneration: target.session.generation,
        },
      });
      setSwitching(false);
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result))
          reportFailure(`Unable to switch ${props.language.displayName}`, result);
        return;
      }
      if (props.contextId !== undefined) {
        useComputeContextStore.getState().markSessionTerminal({
          contextId: props.contextId,
          sessionId: target.session.sessionId,
          generation: target.session.generation,
        });
      }
      setSwitchTarget(null);
      refreshSessions();
      refreshEvents();
      refreshRuntimeInspection();
    }, [
      refreshEvents,
      refreshRuntimeInspection,
      refreshSessions,
      stopSession,
      props.language.displayName,
      props.contextId,
      switchTarget,
      switching,
    ]);

    const run = useCallback(
      async (kind: ComputeRunKind, slice: ComputeCodeSlice | null) => {
        if (slice === null || operation !== null || refreshing || switching) return;
        setOperation(kind);

        let session = liveSession;
        const currentBinding =
          props.contextId === undefined
            ? null
            : (getComputeContext(props.contextId) ??
              ensureComputeContext({
                contextId: props.contextId,
                environmentId: props.environmentId,
                cwd: props.cwd,
                ownerKey: `${props.environmentId}:${props.cwd}:${props.relativePath}`,
                relativePath: props.relativePath,
              }));
        if (
          currentBinding?.lifecycle === "closing" ||
          currentBinding?.lifecycle === "close-failed" ||
          (currentBinding?.lifecycle === "starting" && !capacityBlocked && !canRetryStart)
        ) {
          toastManager.add({
            type: "info",
            title: capacityBlocked
              ? "Compute capacity reached"
              : currentBinding.lifecycle === "starting"
                ? "Compute is starting"
                : "Compute is closing",
            description: capacityBlocked
              ? "Stop an unused session above, then retry with this same tab-owned session."
              : currentBinding.lifecycle === "starting"
                ? startRetryAvailable
                  ? "Retry with the same tab-owned session ID."
                  : "This tab already owns a start in progress."
                : "Retry closing this tab before running it again.",
          });
          setOperation(null);
          return;
        }
        if (
          currentBinding?.sessionId !== null &&
          currentBinding?.sessionId !== undefined &&
          currentBinding.lifecycle === "live" &&
          session === null
        ) {
          toastManager.add({
            type: "info",
            title: "Refreshing this compute tab",
            description:
              "The owned session is not in the current snapshot yet. Try Run again shortly.",
          });
          setOperation(null);
          return;
        }
        if (session === null && readyRuntime === null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `${props.language.displayName} is not ready`,
              description: `Enable and configure ${props.language.displayName} in Scientific Computing settings.`,
            }),
          );
          setOperation(null);
          return;
        }
        onRunRequested();
        if (session === null) {
          const runtime = readyRuntime;
          if (runtime === null) {
            setOperation(null);
            return;
          }
          const sessionId =
            currentBinding?.lifecycle === "terminal" || currentBinding?.sessionId === null
              ? ComputeSessionId.make(randomUUID())
              : (currentBinding?.sessionId ?? ComputeSessionId.make(randomUUID()));
          const requestedGeneration =
            currentBinding?.lifecycle === "terminal" || currentBinding?.sessionId === null
              ? INITIAL_COMPUTE_CONTEXT_GENERATION
              : (currentBinding?.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION);
          if (props.contextId !== undefined) {
            const reserved = useComputeContextStore.getState().reserveSession({
              contextId: props.contextId,
              sessionId,
              generation: requestedGeneration,
            });
            if (!reserved) {
              setOperation(null);
              return;
            }
          }
          setStartRetryAvailable(false);
          const started = await startSession({
            environmentId: props.environmentId,
            input: {
              cwd: props.cwd,
              sessionId,
              languageId: runtime.profile.languageId,
              // Resolve the current default on the server; a cached toolbar is not a user override.
              executable: null,
            },
          });
          if (started._tag !== "Success") {
            setOperation(null);
            const capacityRejected = isComputeCapacityReachedError(
              squashAtomCommandFailure(started),
            );
            setStartRetryAvailable(!capacityRejected);
            setCapacityBlocked(capacityRejected);
            if (capacityRejected && props.contextId !== undefined) {
              useComputeContextStore.getState().releasePendingReservation({
                contextId: props.contextId,
                sessionId,
                generation: requestedGeneration,
              });
            } else {
              void confirmFailedStart(sessionId, requestedGeneration);
            }
            if (!isAtomCommandInterrupted(started))
              reportFailure(`Unable to start ${props.language.displayName}`, started);
            refreshSessions();
            refreshRuntimeInspection();
            return;
          }
          session = started.value;
          setStartRetryAvailable(false);
          setCapacityBlocked(false);
          if (
            props.contextId !== undefined &&
            !useComputeContextStore.getState().bindSession({
              contextId: props.contextId,
              sessionId: session.sessionId,
              generation: session.generation,
            })
          ) {
            setOperation(null);
            const current = getComputeContext(props.contextId);
            if (
              current?.sessionId === session.sessionId &&
              (current.lifecycle === "closing" || current.lifecycle === "close-failed")
            ) {
              void closeComputeContext({
                contextId: props.contextId,
                stopSession,
                getSession,
              });
            }
            return;
          }
          refreshSessions();
        }

        const currentOwner =
          props.contextId === undefined ? null : getComputeContext(props.contextId);
        if (props.contextId !== undefined && !ownsLiveComputeSession(currentOwner, session)) {
          setOperation(null);
          return;
        }

        const executionId = ComputeExecutionId.make(randomUUID());
        const submitted = await submitExecution({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: session.sessionId,
            executionId,
            expectedGeneration: session.generation,
            code: slice.code,
            source: {
              _tag: "document",
              origin: kind,
              path: props.relativePath,
              bufferState: props.sourcePending ? "dirty" : "saved",
              revision: props.sourceRevision,
              range: slice.range,
            },
          },
        });
        setOperation(null);
        if (submitted._tag === "Success") {
          props.onExecutionSubmitted(session.sessionId, executionId);
        } else if (!isAtomCommandInterrupted(submitted)) {
          reportFailure(`Unable to run ${props.language.displayName}`, submitted);
          refreshSessions();
        }
      },
      [
        liveSession,
        operation,
        props.cwd,
        props.environmentId,
        props.onExecutionSubmitted,
        onRunRequested,
        props.language,
        props.relativePath,
        props.sourcePending,
        props.sourceRevision,
        readyRuntime,
        refreshing,
        refreshRuntimeInspection,
        refreshSessions,
        startSession,
        submitExecution,
        switching,
        contextBinding?.lifecycle,
        capacityBlocked,
        startRetryAvailable,
        canRetryStart,
        confirmFailedStart,
        getSession,
        props.contextId,
        stopSession,
      ],
    );

    const lineSelectionSlice =
      props.selection === null ? null : computeLineSelection(props.contents, props.selection);
    const primary = resolveComputeRunTarget(
      props.contents,
      props.selection,
      props.editorSelection,
      props.language.cellMarker,
    );
    const selectionSlice = primary.kind === "selection" ? primary.slice : lineSelectionSlice;
    const caretLine = props.editorSelection?.end.line;
    const cellSlice =
      caretLine === undefined
        ? null
        : computeCell(props.contents, caretLine + 1, props.language.cellMarker);
    const fileSlice = computeFile(props.contents);
    const busy = operation !== null || refreshing || switching || stoppingUnusedSession !== null;

    useImperativeHandle(
      ref,
      () => ({
        runPrimary: (selection) => {
          const target = resolveComputeRunTarget(
            props.contents,
            props.selection,
            selection === undefined ? props.editorSelection : selection,
            props.language.cellMarker,
          );
          void run(target.kind, target.slice);
        },
        runCellAtLine: (line) =>
          void run("cell", computeCell(props.contents, line, props.language.cellMarker)),
      }),
      [props.contents, props.editorSelection, props.selection, props.language.cellMarker, run],
    );

    return (
      <>
        <div className="@container/python-file-actions flex min-w-0 items-center justify-end gap-1.5">
          <div className="hidden min-w-0 flex-1 @[9rem]/python-file-actions:block">
            {capacityBlocked ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      className="-ms-1 h-6 min-w-0 max-w-full px-1 text-[11px] font-normal"
                      disabled={stoppingUnusedSession !== null}
                      aria-label="Choose a compute session to stop"
                      title="Stop an unused compute session to free host capacity"
                    />
                  }
                >
                  <span className="truncate">Capacity · choose session</span>
                </MenuTrigger>
                <MenuPopup align="start" side="bottom" className="min-w-64">
                  {capacitySessions.length === 0 ? (
                    <MenuItem disabled title="Stop a session in another project, then retry">
                      No active sessions in this project
                    </MenuItem>
                  ) : (
                    capacitySessions.map((session) => (
                      <MenuItem
                        key={`${session.sessionId}:${session.generation}`}
                        disabled={stoppingUnusedSession !== null}
                        onClick={() => void stopUnusedSession(session)}
                      >
                        Stop {computeSessionOwnerLabel(session, props.environmentId, props.cwd)} ·{" "}
                        {session.status.replaceAll("-", " ")}
                      </MenuItem>
                    ))
                  )}
                </MenuPopup>
              </Menu>
            ) : runtimeToolbar.kind === "switch" ? (
              <Button
                size="xs"
                variant="ghost-muted"
                className="-ms-1 h-6 min-w-0 max-w-full px-1 text-[11px] font-normal"
                title={`Stop the current session and use the selected ${props.language.displayName}`}
                disabled={switching}
                onClick={requestRuntimeSwitch}
              >
                <span className="truncate">{runtimeToolbar.label}</span>
              </Button>
            ) : (
              <Button
                size="xs"
                variant="ghost-muted"
                className="-ms-1 h-6 min-w-0 max-w-full px-1 text-[11px] font-normal"
                title={`${liveSession?.runtime?.executable ?? readyRuntime?.profile.executable ?? `${props.language.displayName} is unavailable`}. ${missingScientificPackages.length > 0 ? `Missing scientific packages: ${missingScientificPackages.join(", ")}. ` : ""}Open Scientific Computing settings`}
                render={
                  <Link
                    to="/settings/scientific-computing"
                    search={{ environmentId: props.environmentId }}
                  />
                }
              >
                <span className="truncate">{runtimeToolbar.label}</span>
              </Button>
            )}
          </div>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            className="shrink-0"
            aria-label={`Refresh ${props.language.displayName} detection`}
            title={`Check ${props.language.displayName} again`}
            disabled={refreshing || switching}
            onClick={() => void refreshRuntime()}
          >
            {refreshing ? <LoaderCircle className="animate-spin" /> : <RefreshCwIcon />}
          </Button>
          <div className="flex shrink-0 items-center">
            <Button
              size="xs"
              variant="outline"
              className="rounded-r-none px-1.5 @[15rem]/python-file-actions:px-[calc(--spacing(2)-1px)]"
              aria-label={primary.label}
              disabled={busy || !runtimeToolbar.canRun || primary.slice === null}
              onClick={() => void run(primary.kind, primary.slice)}
            >
              {operation === primary.kind ? <LoaderCircle className="animate-spin" /> : <Play />}
              <span className="hidden @[15rem]/python-file-actions:inline">{primary.label}</span>
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="outline"
                    className="rounded-l-none border-l-0"
                    disabled={busy || !runtimeToolbar.canRun}
                    aria-label={`Choose ${props.language.displayName} code to run`}
                  />
                }
              >
                <ChevronDown />
              </MenuTrigger>
              <MenuPopup align="end" side="bottom">
                <MenuItem
                  disabled={selectionSlice === null}
                  onClick={() => void run("selection", selectionSlice)}
                >
                  Run selection
                </MenuItem>
                <MenuItem disabled={cellSlice === null} onClick={() => void run("cell", cellSlice)}>
                  Run cell
                </MenuItem>
                <MenuItem disabled={fileSlice === null} onClick={() => void run("file", fileSlice)}>
                  Run file
                </MenuItem>
                {runtimeToolbar.kind === "switch" ? (
                  <>
                    <MenuSeparator />
                    <MenuItem onClick={requestRuntimeSwitch}>
                      Switch {props.language.displayName} environment…
                    </MenuItem>
                  </>
                ) : null}
              </MenuPopup>
            </Menu>
          </div>
        </div>
        <AlertDialog
          open={switchTarget !== null}
          onOpenChange={(open) => {
            if (!open) setSwitchTarget(null);
          }}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>Switch {props.language.displayName} environment?</AlertDialogTitle>
              <AlertDialogDescription>
                This stops the current {props.language.displayName} session and clears its in-memory
                variables. Run history remains available, and the next run uses the{" "}
                {props.language.displayName} selected in Scientific Computing.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" disabled={switching} />}>
                Cancel
              </AlertDialogClose>
              <Button disabled={switching} onClick={() => void switchRuntime()}>
                {switching ? <LoaderCircle className="animate-spin" /> : null}
                Switch
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </>
    );
  },
);
