import type {
  ComputeExecutionRecord,
  ComputeLanguageRuntimeInspection,
  ComputeOutput,
  ComputeSessionRecord,
  ComputeVariableSnapshot,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  ComputeSessionId,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronDown,
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  MoreHorizontal,
  Play,
  Power,
  RotateCcw,
  RefreshCw,
  Settings2,
  Square,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { ScrollArea } from "~/components/ui/scroll-area";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn, randomUUID } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { useRightPanelStore } from "~/rightPanelStore";
import { getProjectEntriesQueryAtom } from "~/components/files/projectFilesQueryState";

import { ComputeOutputView } from "./ComputeOutputView";
import {
  computeExecutionStatusLabel,
  computeSourceFreshnessLabel,
  computeSourceLabel,
  mergeComputeOutputs,
  selectComputeFigureFallback,
  type ComputeFigureFallback,
} from "./computeResultPresentation";

interface ReadyRuntime {
  readonly language: ComputeLanguageRuntimeInspection;
  readonly candidate: ComputeLanguageRuntimeInspection["runtimes"][number];
  readonly key: string;
}

function statusLabel(status: string): string {
  return status.replaceAll("-", " ");
}

function operationFailure(
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

function ResultLoadError(props: { readonly error: string; readonly noun: "result" | "messages" }) {
  return (
    <div className="text-xs text-destructive">
      <p>Couldn&apos;t load {props.noun === "result" ? "this result" : "these messages"}.</p>
      <details className="mt-1 text-[11px] text-muted-foreground">
        <summary className="cursor-pointer">Details</summary>
        <p className="mt-1 break-words">{props.error}</p>
      </details>
    </div>
  );
}

function ComputeExecutionCard(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly execution: ComputeExecutionRecord;
  readonly focused: boolean;
  readonly includeSourcePath: boolean;
  readonly liveOutputs: ReadonlyArray<ComputeOutput>;
  readonly liveOutputsClipped: boolean;
  readonly figureFallback: ComputeFigureFallback | null;
  readonly fallbackLiveOutputs: ReadonlyArray<ComputeOutput>;
  readonly rehydrationToken: string | null;
  readonly session: ComputeSessionRecord;
  readonly sourceRevision: string | null;
  readonly sourcePending: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly onCancel: (execution: ComputeExecutionRecord) => void;
  readonly onFocusConsumed?: (executionId: string) => void;
  readonly onSelectExecution: (executionId: string) => void;
}) {
  const outputsAtom = computeEnvironment.outputs({
    environmentId: props.environmentId,
    input: {
      cwd: props.cwd,
      sessionId: props.session.sessionId,
      executionId: props.execution.request.executionId,
    },
  });
  const persistedOutputs = useEnvironmentQuery(outputsAtom);
  const fallbackOutputsAtom =
    props.figureFallback === null
      ? null
      : computeEnvironment.outputs({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: props.session.sessionId,
            executionId: props.figureFallback.execution.request.executionId,
          },
        });
  const persistedFallbackOutputs = useEnvironmentQuery(fallbackOutputsAtom);
  const terminal =
    props.execution.result !== null &&
    TERMINAL_COMPUTE_EXECUTION_STATUSES.has(props.execution.result.status);
  const persisted = persistedOutputs.data;
  const outputs = useMemo(
    () => mergeComputeOutputs(persisted?.outputs ?? [], props.liveOutputs),
    [persisted?.outputs, props.liveOutputs],
  );
  const fallbackOutputs = useMemo(
    () =>
      mergeComputeOutputs(
        persistedFallbackOutputs.data?.outputs ?? [],
        props.fallbackLiveOutputs,
      ).filter((output) => output._tag === "image"),
    [persistedFallbackOutputs.data?.outputs, props.fallbackLiveOutputs],
  );
  const terminalRefreshRequestedRef = useRef(false);

  useEffect(() => {
    if (!props.focused) return;
    props.onFocusConsumed?.(props.execution.request.executionId);
  }, [props.execution.request.executionId, props.focused, props.onFocusConsumed]);

  useEffect(() => {
    if (!terminal) {
      terminalRefreshRequestedRef.current = false;
      return;
    }
    if (terminalRefreshRequestedRef.current) return;
    terminalRefreshRequestedRef.current = true;
    persistedOutputs.refresh();
    // Confirm durable truth once for a terminal run, including one first mounted after completion.
  }, [terminal]);

  useEffect(() => {
    if (props.rehydrationToken === null) return;
    persistedOutputs.refresh();
    if (props.figureFallback !== null) persistedFallbackOutputs.refresh();
    // One durable reread per observed gap token; the stream is only notification authority.
  }, [props.rehydrationToken]);

  const source = props.execution.request.source;
  const sourceFreshness = computeSourceFreshnessLabel(
    source,
    props.sourceRevision === null
      ? null
      : { revision: props.sourceRevision, pending: props.sourcePending },
  );
  const sourceContext = [
    computeSourceLabel(source, { includePath: props.includeSourcePath }),
    sourceFreshness,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const status = computeExecutionStatusLabel(props.execution.result);
  const showHeader =
    props.includeSourcePath ||
    sourceContext !== "File" ||
    sourceFreshness !== null ||
    status !== "Succeeded";
  return (
    <section
      className={props.includeSourcePath ? "rounded-lg border border-border/70 bg-card/50" : ""}
      aria-label="Selected compute result"
    >
      {showHeader ? (
        <header
          className={
            props.includeSourcePath
              ? "flex w-full items-center gap-2 px-3 py-2.5 text-left"
              : "mb-2 flex w-full items-center gap-2 text-left"
          }
        >
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{sourceContext}</span>
          <span className="shrink-0 text-[11px] text-muted-foreground">{status}</span>
        </header>
      ) : null}
      <div
        className={
          props.includeSourcePath ? "space-y-3 border-t border-border/60 px-3 py-3" : "space-y-3"
        }
      >
        {outputs.length === 0 && persistedOutputs.error ? (
          <ResultLoadError error={persistedOutputs.error} noun="result" />
        ) : outputs.length === 0 && persistedOutputs.isPending ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" /> Loading result…
          </p>
        ) : (
          <ComputeOutputView
            environmentId={props.environmentId}
            session={props.session}
            executionId={props.execution.request.executionId}
            outputs={outputs}
            emptyLabel={
              props.execution.result?.status === "succeeded"
                ? "Completed without output."
                : terminal
                  ? "No output was produced."
                  : "Waiting for output…"
            }
            {...(persisted === null ? {} : { corruptLineCount: persisted.corruptLineCount })}
            clipped={persisted === null && props.liveOutputsClipped}
            threadRef={props.threadRef}
            sourcePath={source._tag === "document" ? source.path : null}
          />
        )}
        {props.figureFallback !== null && !outputs.some((output) => output._tag === "image") ? (
          <div className="space-y-2 pt-1">
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1.5 rounded-[4px] px-1.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
              onClick={() => {
                const fallback = props.figureFallback;
                if (fallback !== null) {
                  props.onSelectExecution(fallback.execution.request.executionId);
                }
              }}
            >
              <span>
                {props.figureFallback.reason === "updating"
                  ? "Updating · previous figures"
                  : "Latest run failed · previous figures"}
              </span>
              <span>·</span>
              <time dateTime={props.figureFallback.execution.request.submittedAt}>
                {new Date(props.figureFallback.execution.request.submittedAt).toLocaleTimeString()}
              </time>
            </button>
            {fallbackOutputs.length === 0 && persistedFallbackOutputs.error ? (
              <ResultLoadError error={persistedFallbackOutputs.error} noun="result" />
            ) : fallbackOutputs.length === 0 && persistedFallbackOutputs.isPending ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3 animate-spin" /> Loading previous figures…
              </p>
            ) : (
              <ComputeOutputView
                environmentId={props.environmentId}
                session={props.session}
                executionId={props.figureFallback.execution.request.executionId}
                outputs={fallbackOutputs}
                emptyLabel="Previous figures are unavailable."
                threadRef={props.threadRef}
                sourcePath={
                  props.figureFallback.execution.request.source._tag === "document"
                    ? props.figureFallback.execution.request.source.path
                    : null
                }
              />
            )}
          </div>
        ) : null}
        {((props.includeSourcePath && source._tag === "document") || !terminal) && (
          <div className="flex items-center gap-2">
            {props.includeSourcePath && source._tag === "document" ? (
              <button
                type="button"
                className="cursor-pointer text-[11px] text-muted-foreground underline-offset-2 hover:underline"
                onClick={() =>
                  useRightPanelStore
                    .getState()
                    .openFile(
                      props.threadRef,
                      source.path,
                      source.range === null ? undefined : source.range.startLine + 1,
                    )
                }
              >
                Open source
              </button>
            ) : null}
            {!terminal ? (
              <Button size="xs" variant="outline" onClick={() => props.onCancel(props.execution)}>
                <Square className="size-3" /> Cancel
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </section>
  );
}

function ComputeSessionMessages(props: {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly liveOutputs: ReadonlyArray<ComputeOutput>;
  readonly liveOutputsClipped: boolean;
  readonly rehydrationToken: string | null;
  readonly session: ComputeSessionRecord;
  readonly threadRef: ScopedThreadRef;
}) {
  const [expanded, setExpanded] = useState(false);
  const outputsAtom = expanded
    ? computeEnvironment.outputs({
        environmentId: props.environmentId,
        input: {
          cwd: props.cwd,
          sessionId: props.session.sessionId,
          executionId: null,
        },
      })
    : null;
  const persistedOutputs = useEnvironmentQuery(outputsAtom);
  const persisted = persistedOutputs.data;
  const outputs = useMemo(
    () => mergeComputeOutputs(persisted?.outputs ?? [], props.liveOutputs),
    [persisted?.outputs, props.liveOutputs],
  );

  useEffect(() => {
    if (expanded && props.rehydrationToken !== null) persistedOutputs.refresh();
    // One durable reread per observed gap token.
  }, [expanded, props.rehydrationToken]);

  return (
    <article className="rounded-lg border border-border/70 bg-card/30">
      <button
        type="button"
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left"
        onClick={() => setExpanded((current) => !current)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="text-[11px] font-medium text-muted-foreground">Session notices</span>
      </button>
      {expanded ? (
        <div className="border-t border-border/60 px-3 py-3">
          {persistedOutputs.error ? (
            <ResultLoadError error={persistedOutputs.error} noun="messages" />
          ) : persistedOutputs.isPending && outputs.length === 0 ? (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3 animate-spin" /> Loading notices…
            </p>
          ) : (
            <ComputeOutputView
              environmentId={props.environmentId}
              session={props.session}
              executionId={null}
              outputs={outputs}
              {...(persisted === null ? {} : { corruptLineCount: persisted.corruptLineCount })}
              clipped={persisted === null && props.liveOutputsClipped}
              threadRef={props.threadRef}
            />
          )}
        </div>
      ) : null}
    </article>
  );
}

function ComputeVariablesView(props: {
  readonly snapshot: ComputeVariableSnapshot | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly available: boolean;
  readonly hasLiveSession: boolean;
  readonly busy: boolean;
  readonly selectedIsLive: boolean;
  readonly onShowLive: () => void;
  readonly onRefresh: () => void;
}) {
  if (!props.hasLiveSession) {
    return (
      <div className="flex min-h-40 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        Run a Python file to start a live session and inspect its variables.
      </div>
    );
  }
  if (!props.selectedIsLive) {
    return (
      <div className="flex min-h-40 items-center justify-center p-6 text-center">
        <div>
          <p className="text-sm font-medium">Variables belong to the live session</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Past runs keep their results, but they do not keep a copy of the mutable namespace.
          </p>
          <Button className="mt-3" size="xs" variant="outline" onClick={props.onShowLive}>
            Show live session
          </Button>
        </div>
      </div>
    );
  }
  if (!props.available) {
    return (
      <div className="flex min-h-40 items-center justify-center p-6 text-center text-xs text-muted-foreground">
        This runtime does not provide safe variable inspection.
      </div>
    );
  }
  if (props.busy) {
    return (
      <div className="flex min-h-40 items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <LoaderCircle className="size-3 animate-spin" /> Variables will refresh when this run
        finishes.
      </div>
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="p-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-[11px] text-muted-foreground">
            Current namespace · not saved in run history
          </span>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Refresh current variables"
            disabled={props.loading}
            onClick={props.onRefresh}
          >
            {props.loading ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
          </Button>
        </div>
        {props.error !== null ? (
          <div className="rounded-[6px] border border-destructive/25 bg-destructive/5 p-3 text-xs text-destructive">
            {props.error}
          </div>
        ) : props.snapshot === null && props.loading ? (
          <p className="flex min-h-32 items-center justify-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-3 animate-spin" /> Reading current variables…
          </p>
        ) : props.snapshot === null || props.snapshot.variables.length === 0 ? (
          <p className="flex min-h-32 items-center justify-center text-xs text-muted-foreground">
            No user variables in this session yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-[6px] border border-border/70">
            <div className="grid min-w-[34rem] grid-cols-[minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(7rem,1fr)_minmax(8rem,1.4fr)] gap-3 border-b border-border/60 bg-muted/30 px-3 py-2 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              <span>Name</span>
              <span>Type</span>
              <span>Shape / size</span>
              <span>Preview</span>
            </div>
            {props.snapshot.variables.map((variable) => (
              <div
                key={variable.name}
                className="grid min-w-[34rem] grid-cols-[minmax(7rem,1fr)_minmax(6rem,0.8fr)_minmax(7rem,1fr)_minmax(8rem,1.4fr)] gap-3 border-b border-border/50 px-3 py-2 text-xs last:border-b-0"
              >
                <code className="truncate font-medium text-foreground">{variable.name}</code>
                <span className="truncate text-muted-foreground">{variable.typeName}</span>
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {variable.shape ?? (variable.size === null ? "—" : String(variable.size))}
                </span>
                <code className="truncate text-[11px] text-muted-foreground">
                  {variable.preview ?? "—"}
                </code>
              </div>
            ))}
            {props.snapshot.truncated ? (
              <p className="border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
                Showing the first 200 variables.
              </p>
            ) : null}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}

export function ComputePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly threadRef: ScopedThreadRef;
  readonly sourcePath?: string;
  readonly sourceRevision?: string;
  readonly sourcePending?: boolean;
  readonly focusExecutionId?: string | null;
  readonly onFocusConsumed?: (executionId: string) => void;
  readonly embedded?: boolean;
}) {
  const [panelView, setPanelView] = useState<"results" | "variables">("results");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [runtimeKey, setRuntimeKey] = useState("");
  const [operation, setOperation] = useState<
    "start" | "cancel" | "interrupt" | "restart" | "stop" | null
  >(null);
  const [sessionConfirmation, setSessionConfirmation] = useState<"restart" | "stop" | null>(null);
  const [variableSnapshot, setVariableSnapshot] = useState<ComputeVariableSnapshot | null>(null);
  const [variableError, setVariableError] = useState<string | null>(null);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const observedTerminalExecutionsRef = useRef<Set<string> | null>(null);
  const newestExecutionRef = useRef<string | null>(null);
  const variableRequestRef = useRef(0);

  const runtimes = useEnvironmentQuery(
    computeEnvironment.runtimes({
      environmentId: props.environmentId,
      input: { cwd: props.cwd, refresh: false },
    }),
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
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const cancelExecution = useAtomCommand(computeEnvironment.cancelExecution, {
    reportFailure: false,
  });
  const interruptSession = useAtomCommand(computeEnvironment.interruptSession, {
    reportFailure: false,
  });
  const restartSession = useAtomCommand(computeEnvironment.restartSession, {
    reportFailure: false,
  });
  const stopSession = useAtomCommand(computeEnvironment.stopSession, { reportFailure: false });
  const inspectVariables = useAtomCommand(computeEnvironment.inspectVariables, {
    reportFailure: false,
  });

  const readyRuntimes = useMemo<ReadonlyArray<ReadyRuntime>>(
    () =>
      (runtimes.data?.languages ?? []).flatMap((language) =>
        language.runtimes.flatMap((candidate) =>
          language.enabled && candidate.verification.readiness === "ready"
            ? [
                {
                  language,
                  candidate,
                  key: `${language.descriptor.languageId}:${candidate.profile.executable}`,
                },
              ]
            : [],
        ),
      ),
    [runtimes.data],
  );
  const selectedRuntime =
    readyRuntimes.find((runtime) => runtime.key === runtimeKey) ?? readyRuntimes[0] ?? null;

  const allSessions = useMemo(() => {
    const byId = new Map<string, ComputeSessionRecord>();
    for (const session of sessions.data ?? []) byId.set(session.sessionId, session);
    for (const session of events.data?.sessions.values() ?? []) {
      byId.set(session.sessionId, session);
    }
    return [...byId.values()].toSorted((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }, [events.data?.sessions, sessions.data]);
  const liveSession =
    allSessions.find((session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status)) ?? null;
  const selectedSession =
    allSessions.find((session) => session.sessionId === selectedSessionId) ??
    liveSession ??
    allSessions[0] ??
    null;
  const selectedIsLive =
    liveSession !== null && selectedSession?.sessionId === liveSession.sessionId;
  const variablesAvailable =
    liveSession !== null &&
    (runtimes.data?.languages
      .find((language) => language.descriptor.languageId === liveSession.languageId)
      ?.descriptor.capabilities.includes("variables") ??
      false);

  const executions = useEnvironmentQuery(
    selectedSession === null
      ? null
      : computeEnvironment.executions({
          environmentId: props.environmentId,
          input: { cwd: props.cwd, sessionId: selectedSession.sessionId, limit: 100 },
        }),
  );
  const selectedExecutions = useMemo(() => {
    if (selectedSession === null) return [];
    const byId = new Map<string, ComputeExecutionRecord>();
    for (const execution of executions.data ?? []) {
      byId.set(execution.request.executionId, execution);
    }
    const streamed = events.data?.executions.get(selectedSession.sessionId);
    for (const execution of streamed?.values() ?? []) {
      byId.set(execution.request.executionId, execution);
    }
    return [...byId.values()]
      .filter(
        (execution) =>
          props.sourcePath === undefined ||
          (execution.request.source._tag === "document" &&
            execution.request.source.path === props.sourcePath),
      )
      .toSorted((left, right) => right.request.submittedAt.localeCompare(left.request.submittedAt));
  }, [events.data?.executions, executions.data, props.sourcePath, selectedSession]);
  const selectedExecution =
    selectedExecutions.find((execution) => execution.request.executionId === selectedExecutionId) ??
    selectedExecutions[0] ??
    null;
  const selectedLiveOutputState =
    selectedSession === null || selectedExecution === null
      ? undefined
      : events.data?.outputs.get(
          `${selectedSession.sessionId}/${selectedExecution.request.executionId}`,
        );
  const figureFallback = selectComputeFigureFallback(
    selectedExecutions,
    selectedExecution,
    selectedLiveOutputState?.hasImage ?? false,
  );
  const fallbackLiveOutputState =
    selectedSession === null || figureFallback === null
      ? undefined
      : events.data?.outputs.get(
          `${selectedSession.sessionId}/${figureFallback.execution.request.executionId}`,
        );
  const rehydrationToken = events.data?.observedGap
    ? `${events.data.observedGap.expected}:${events.data.observedGap.received}`
    : null;
  const variablesRefreshToken = useMemo(() => {
    if (liveSession === null) return null;
    const latest = [...(events.data?.executions.get(liveSession.sessionId)?.values() ?? [])]
      .filter(
        (execution) =>
          execution.result !== null &&
          TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status),
      )
      .toSorted((left, right) => left.request.submittedAt.localeCompare(right.request.submittedAt))
      .at(-1);
    return `${liveSession.sessionId}:${liveSession.generation}:${latest?.request.executionId ?? "empty"}:${latest?.result?.finishedAt ?? ""}`;
  }, [events.data?.executions, liveSession]);

  const refreshVariables = useCallback(async () => {
    if (
      panelView !== "variables" ||
      liveSession === null ||
      !selectedIsLive ||
      !variablesAvailable ||
      liveSession.status !== "ready" ||
      liveSession.activity !== "idle"
    ) {
      return;
    }
    const request = variableRequestRef.current + 1;
    variableRequestRef.current = request;
    setVariablesLoading(true);
    setVariableError(null);
    const result = await inspectVariables({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: liveSession.sessionId,
        expectedGeneration: liveSession.generation,
      },
    });
    if (request !== variableRequestRef.current) return;
    setVariablesLoading(false);
    if (result._tag === "Success") {
      setVariableSnapshot(result.value);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    setVariableError(
      error instanceof Error ? error.message : "Unable to inspect the current variables.",
    );
  }, [
    inspectVariables,
    liveSession,
    panelView,
    props.cwd,
    props.environmentId,
    selectedIsLive,
    variablesAvailable,
  ]);

  useEffect(() => {
    if (selectedSession !== null && selectedSession.sessionId !== selectedSessionId) {
      setSelectedSessionId(selectedSession.sessionId);
    }
  }, [selectedSession, selectedSessionId]);

  useEffect(() => {
    if (props.focusExecutionId) setSelectedExecutionId(props.focusExecutionId);
  }, [props.focusExecutionId]);

  useEffect(() => {
    variableRequestRef.current += 1;
    setVariableSnapshot(null);
    setVariableError(null);
    setVariablesLoading(false);
  }, [liveSession?.generation, liveSession?.sessionId]);

  useEffect(() => {
    void refreshVariables();
  }, [refreshVariables, variablesRefreshToken]);

  useEffect(() => {
    const newestId = selectedExecutions[0]?.request.executionId ?? null;
    if (newestId !== null && newestId !== newestExecutionRef.current) {
      setSelectedExecutionId(newestId);
    }
    newestExecutionRef.current = newestId;
  }, [selectedExecutions]);

  useEffect(() => {
    if (!events.data?.stale) return;
    sessions.refresh();
    executions.refresh();
    events.refresh();
    // Query refresh functions are stable; the stale boundary is the trigger.
  }, [events.data?.stale]);

  useEffect(() => {
    const terminalIds = new Set(
      selectedExecutions.flatMap((execution) =>
        execution.result !== null &&
        TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)
          ? [execution.request.executionId]
          : [],
      ),
    );
    const observed = observedTerminalExecutionsRef.current;
    observedTerminalExecutionsRef.current = terminalIds;
    if (observed === null || [...terminalIds].every((id) => observed.has(id))) return;
    sessions.refresh();
    executions.refresh();
    appAtomRegistry.refresh(getProjectEntriesQueryAtom(props.environmentId, props.cwd));
    // Refresh ordinary workspace state once after a newly terminal execution.
  }, [props.cwd, props.environmentId, selectedExecutions]);

  const handleStart = async () => {
    if (selectedRuntime === null) return;
    setOperation("start");
    const result = await startSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: ComputeSessionId.make(randomUUID()),
        languageId: selectedRuntime.language.descriptor.languageId,
        executable: selectedRuntime.candidate.profile.executable,
      },
    });
    setOperation(null);
    if (result._tag === "Success") {
      setSelectedSessionId(result.value.sessionId);
      sessions.refresh();
    } else if (!isAtomCommandInterrupted(result)) {
      operationFailure("Unable to start compute", result);
      runtimes.refresh();
      sessions.refresh();
    }
  };

  const runSessionCommand = async (kind: "interrupt" | "restart" | "stop") => {
    if (liveSession === null) return;
    setOperation(kind);
    const command =
      kind === "interrupt" ? interruptSession : kind === "restart" ? restartSession : stopSession;
    const result = await command({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: liveSession.sessionId,
        expectedGeneration: liveSession.generation,
      },
    });
    setOperation(null);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      operationFailure(`Unable to ${kind} compute`, result);
    }
    sessions.refresh();
    executions.refresh();
  };

  const handleCancel = async (execution: ComputeExecutionRecord) => {
    if (selectedSession === null) return;
    setOperation("cancel");
    const result = await cancelExecution({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: selectedSession.sessionId,
        executionId: execution.request.executionId,
        expectedGeneration: selectedSession.generation,
      },
    });
    setOperation(null);
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      operationFailure("Unable to cancel execution", result);
    }
    executions.refresh();
  };

  const confirmSessionCommand = () => {
    const kind = sessionConfirmation;
    if (kind === null) return;
    setSessionConfirmation(null);
    void runSessionCommand(kind);
  };

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Scientific results">
      <header className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1" role="tablist" aria-label="Compute view">
            <button
              type="button"
              role="tab"
              aria-selected={panelView === "results"}
              className={cn(
                "cursor-pointer rounded-[4px] px-1.5 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
                panelView === "results" && "text-foreground",
              )}
              onClick={() => setPanelView("results")}
            >
              {props.embedded ? "Results" : "Compute"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={panelView === "variables"}
              className={cn(
                "cursor-pointer rounded-[4px] px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground",
                panelView === "variables" && "text-foreground",
              )}
              onClick={() => setPanelView("variables")}
            >
              Variables
            </button>
            {selectedSession && !props.embedded ? (
              <span className="text-[11px] capitalize text-muted-foreground">
                {statusLabel(selectedSession.status)}
                {selectedSession.status === "ready" ? ` · ${selectedSession.activity}` : ""}
              </span>
            ) : null}
          </div>
          {allSessions.length > (props.embedded ? 1 : 0) ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    className="-ms-1.5 mt-0.5 h-6 max-w-full gap-1 px-1.5 font-normal text-muted-foreground"
                    aria-label="Compute session history"
                  >
                    <span className="truncate">
                      {selectedSession
                        ? `${new Date(selectedSession.createdAt).toLocaleString()} · ${statusLabel(selectedSession.status)}`
                        : "Session history"}
                    </span>
                    <ChevronDown className="size-3.5 shrink-0" />
                  </Button>
                }
              />
              <MenuPopup align="start" side="bottom" className="min-w-56">
                <MenuRadioGroup
                  value={selectedSession?.sessionId ?? ""}
                  onValueChange={(sessionId) => setSelectedSessionId(sessionId)}
                >
                  {allSessions.map((session) => (
                    <MenuRadioItem
                      key={session.sessionId}
                      value={session.sessionId}
                      className="min-h-7 py-1 sm:text-xs"
                    >
                      {new Date(session.createdAt).toLocaleString()} · {statusLabel(session.status)}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {liveSession ? (
          <div className="flex items-center gap-1">
            {!selectedIsLive ? (
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setSelectedSessionId(liveSession.sessionId)}
              >
                Live
              </Button>
            ) : null}
            {liveSession.activity === "busy" ? (
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label="Interrupt running code and keep session state"
                disabled={operation !== null}
                onClick={() => void runSessionCommand("interrupt")}
              >
                {operation === "interrupt" ? <LoaderCircle className="animate-spin" /> : <Square />}
                {operation === "interrupt" ? "Interrupting" : "Interrupt"}
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Session actions"
                    disabled={operation !== null}
                  />
                }
              >
                {operation === "restart" || operation === "stop" ? (
                  <LoaderCircle className="animate-spin" />
                ) : (
                  <MoreHorizontal />
                )}
              </MenuTrigger>
              <MenuPopup align="end" side="bottom" className="min-w-44">
                <MenuItem onClick={() => setSessionConfirmation("restart")}>
                  <RotateCcw />
                  Restart session
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => setSessionConfirmation("stop")}>
                  <Power />
                  Stop session
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : !props.embedded && allSessions.length > 0 && readyRuntimes.length > 0 ? (
          <Button
            size="xs"
            variant="outline"
            disabled={operation !== null}
            onClick={() => void handleStart()}
          >
            {operation === "start" ? <LoaderCircle className="animate-spin" /> : <Play />}
            Start new session
          </Button>
        ) : !props.embedded && allSessions.length > 0 && !runtimes.isPending ? (
          <Button
            size="xs"
            variant="ghost-muted"
            render={<Link to="/settings/scientific-computing" />}
          >
            Set up compute
          </Button>
        ) : null}
      </header>

      {events.data?.stale ? (
        <div className="flex items-center gap-2 border-b border-warning/20 bg-warning/5 px-3 py-2 text-xs text-warning">
          <LoaderCircle className="size-3 animate-spin" /> Refreshing compute history after a stream
          gap…
        </div>
      ) : null}

      {panelView === "variables" ? (
        <ComputeVariablesView
          snapshot={variableSnapshot}
          loading={variablesLoading}
          error={variableError}
          available={variablesAvailable}
          hasLiveSession={liveSession !== null}
          busy={liveSession?.activity === "busy"}
          selectedIsLive={selectedIsLive}
          onShowLive={() => {
            if (liveSession !== null) setSelectedSessionId(liveSession.sessionId);
          }}
          onRefresh={() => void refreshVariables()}
        />
      ) : selectedSession ? (
        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-2 p-3">
            {!props.embedded &&
            (events.data?.outputs.get(`${selectedSession.sessionId}/@session`)?.outputs.length ??
              0) > 0 ? (
              <ComputeSessionMessages
                cwd={props.cwd}
                environmentId={props.environmentId}
                liveOutputs={
                  events.data?.outputs.get(`${selectedSession.sessionId}/@session`)?.outputs ?? []
                }
                liveOutputsClipped={
                  events.data?.outputs.get(`${selectedSession.sessionId}/@session`)?.clipped ??
                  false
                }
                rehydrationToken={rehydrationToken}
                session={selectedSession}
                threadRef={props.threadRef}
              />
            ) : null}
            {selectedExecutions.length === 0 ? (
              <div className="flex min-h-40 items-center justify-center text-center text-xs text-muted-foreground">
                {executions.isPending
                  ? "Loading history…"
                  : props.sourcePath
                    ? "Run this file to see its results."
                    : "Run code from a Python file to begin this session."}
              </div>
            ) : (
              <>
                {selectedExecutions.length > 1 ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] font-medium text-muted-foreground">Runs</span>
                    <select
                      className="max-w-[70%] cursor-pointer bg-transparent text-right text-[11px] text-muted-foreground outline-none"
                      value={selectedExecution?.request.executionId ?? ""}
                      onChange={(event) => setSelectedExecutionId(event.currentTarget.value)}
                      aria-label="Execution history"
                    >
                      {selectedExecutions.map((execution) => (
                        <option
                          key={execution.request.executionId}
                          value={execution.request.executionId}
                        >
                          {new Date(execution.request.submittedAt).toLocaleTimeString()} ·{" "}
                          {computeSourceLabel(execution.request.source, {
                            includePath: !props.embedded,
                          })}{" "}
                          · {computeExecutionStatusLabel(execution.result)}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {selectedExecution ? (
                  <ComputeExecutionCard
                    key={selectedExecution.request.executionId}
                    cwd={props.cwd}
                    environmentId={props.environmentId}
                    execution={selectedExecution}
                    focused={props.focusExecutionId === selectedExecution.request.executionId}
                    includeSourcePath={!props.embedded}
                    liveOutputs={selectedLiveOutputState?.outputs ?? []}
                    liveOutputsClipped={selectedLiveOutputState?.clipped ?? false}
                    figureFallback={figureFallback}
                    fallbackLiveOutputs={fallbackLiveOutputState?.outputs ?? []}
                    rehydrationToken={rehydrationToken}
                    session={selectedSession}
                    sourceRevision={props.sourceRevision ?? null}
                    sourcePending={props.sourcePending ?? false}
                    threadRef={props.threadRef}
                    onCancel={(target) => void handleCancel(target)}
                    onSelectExecution={setSelectedExecutionId}
                    {...(props.onFocusConsumed === undefined
                      ? {}
                      : { onFocusConsumed: props.onFocusConsumed })}
                  />
                ) : null}
              </>
            )}
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            {runtimes.isPending ? (
              <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
            ) : readyRuntimes.length === 0 ? (
              <>
                <CircleAlert className="mx-auto size-5 text-muted-foreground" />
                <p className="mt-3 text-sm font-medium">No compute runtime is ready</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Enable a language and choose an existing runtime. Scient will not install packages
                  or change licenses for you.
                </p>
                <Button
                  className="mt-4"
                  size="sm"
                  variant="outline"
                  render={<Link to="/settings/scientific-computing" />}
                >
                  <Settings2 /> Scientific Computing settings
                </Button>
              </>
            ) : (
              <>
                <p className="text-sm font-medium">Start a scientific session</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  One live session is kept for this project. Past sessions remain in history.
                </p>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  Code runs with this server environment&apos;s filesystem and network access. It is
                  not sandboxed.
                </p>
                {readyRuntimes.length > 1 ? (
                  <select
                    className="mt-4 h-8 max-w-full cursor-pointer rounded-md border border-input bg-background px-2 text-xs"
                    value={selectedRuntime?.key ?? ""}
                    onChange={(event) => setRuntimeKey(event.currentTarget.value)}
                    aria-label="Runtime"
                  >
                    {readyRuntimes.map((runtime) => (
                      <option key={runtime.key} value={runtime.key}>
                        {runtime.candidate.profile.displayName}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  className="mt-4"
                  size="sm"
                  disabled={operation !== null}
                  onClick={() => void handleStart()}
                >
                  {operation === "start" ? <LoaderCircle className="animate-spin" /> : <Play />}
                  Start session
                </Button>
              </>
            )}
          </div>
        </div>
      )}
      <AlertDialog
        open={sessionConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setSessionConfirmation(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {sessionConfirmation === "restart" ? "Restart this session?" : "Stop this session?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {sessionConfirmation === "restart"
                ? "Running and queued code will be cancelled, and all Python variables will be cleared. Run history and retained results stay available."
                : "The Python kernel will close and its in-memory variables will be lost. Run history and retained results stay available."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={sessionConfirmation === "stop" ? "destructive" : "default"}
              onClick={confirmSessionCommand}
            >
              {sessionConfirmation === "restart" ? "Restart session" : "Stop session"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </section>
  );
}
