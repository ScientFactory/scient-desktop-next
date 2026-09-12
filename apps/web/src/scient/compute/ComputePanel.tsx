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
  ComputeLanguageId,
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
  History,
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
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle } from "~/components/ui/popover";
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
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { cn, randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useRightPanelStore } from "~/rightPanelStore";
import { scientComputeSurface } from "~/scient/rightPanel/surfaces";
import { refreshProjectFiles } from "~/components/files/projectFilesQueryState";

import { ComputeOutputView } from "./ComputeOutputView";
import { ComputeSavedFileAction } from "./ComputeSavedFileAction";
import { ManagedRuntimeCard } from "./ScientificComputingSettings";
import { defaultComputeRuntime, isComputeCapacityReachedError } from "./computeFileSurfaceModel";
import { closeComputeContext, mergeComputeSessionRecords } from "./computeContextCoordinator";
import {
  computeSessionOwnerLabel,
  ensureComputeContext,
  getComputeContext,
  INITIAL_COMPUTE_CONTEXT_GENERATION,
  useComputeContextStore,
  type ComputeContextId,
} from "./computeContextStore";
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

const PYTHON_LANGUAGE_ID = ComputeLanguageId.make("python");

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
  readonly allowFigureFollowing: boolean;
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
            allowFigureFollowing={props.allowFigureFollowing}
            cwd={props.cwd}
            environmentId={props.environmentId}
            session={props.session}
            executionId={props.execution.request.executionId}
            executionGeneration={props.execution.request.generation}
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
            source={source}
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
                allowFigureFollowing={props.allowFigureFollowing}
                cwd={props.cwd}
                environmentId={props.environmentId}
                session={props.session}
                executionId={props.figureFallback.execution.request.executionId}
                executionGeneration={props.figureFallback.execution.request.generation}
                outputs={fallbackOutputs}
                emptyLabel="Previous figures are unavailable."
                threadRef={props.threadRef}
                source={props.figureFallback.execution.request.source}
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
              cwd={props.cwd}
              environmentId={props.environmentId}
              session={props.session}
              executionId={null}
              outputs={outputs}
              {...(persisted === null ? {} : { corruptLineCount: persisted.corruptLineCount })}
              clipped={persisted === null && props.liveOutputsClipped}
              threadRef={props.threadRef}
              source={null}
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
        Run a source file to start a live session and inspect its variables.
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
  readonly sourceLanguageId?: string;
  readonly sourceRevision?: string;
  readonly sourcePending?: boolean;
  readonly focusSessionId?: string | null;
  readonly focusExecutionId?: string | null;
  readonly onFocusConsumed?: (executionId: string) => void;
  readonly contextId?: ComputeContextId;
  readonly onRetryClose?: () => void;
  readonly onRunSource?: () => void;
  readonly embedded?: boolean;
}) {
  const [panelView, setPanelView] = useState<"results" | "variables">("results");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [runtimeKey, setRuntimeKey] = useState("");
  const [operation, setOperation] = useState<
    "start" | "cancel" | "interrupt" | "restart" | "stop" | null
  >(null);
  const [sessionConfirmation, setSessionConfirmation] = useState<{
    readonly kind: "restart" | "stop";
    readonly session: ComputeSessionRecord;
    readonly anchorRect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  } | null>(null);
  const [capacityBlocked, setCapacityBlocked] = useState(false);
  const [stoppingUnusedSession, setStoppingUnusedSession] = useState<ComputeSessionId | null>(null);
  const [startRetryAvailable, setStartRetryAvailable] = useState(false);
  const [variableSnapshot, setVariableSnapshot] = useState<ComputeVariableSnapshot | null>(null);
  const [variableError, setVariableError] = useState<string | null>(null);
  const [variablesLoading, setVariablesLoading] = useState(false);
  const contextBinding = useComputeContextStore((state) =>
    props.contextId === undefined ? null : (state.bindings[props.contextId] ?? null),
  );
  const observedTerminalExecutionsRef = useRef<Set<string> | null>(null);
  const newestExecutionRef = useRef<string | null>(null);
  const variableRequestRef = useRef(0);
  const scientificComputing = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.scientificComputing,
  );
  const updateEnvironmentSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });

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
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const getSession = useAtomQueryRunner(computeEnvironment.session, {
    reportFailure: false,
    refresh: true,
  });
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
          language.enabled &&
          candidate.verification.readiness === "ready" &&
          (props.sourceLanguageId === undefined ||
            language.descriptor.languageId === props.sourceLanguageId)
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
    [runtimes.data, props.sourceLanguageId],
  );
  const defaultRuntime = defaultComputeRuntime(
    (runtimes.data?.languages ?? []).filter(
      (language) =>
        props.sourceLanguageId === undefined ||
        language.descriptor.languageId === props.sourceLanguageId,
    ),
  );
  const selectedRuntime =
    runtimeKey === ""
      ? (readyRuntimes.find((runtime) => runtime.candidate === defaultRuntime) ?? null)
      : (readyRuntimes.find((runtime) => runtime.key === runtimeKey) ?? null);
  const pythonLanguage =
    runtimes.data?.languages.find((language) => language.descriptor.languageId === "python") ??
    null;
  const pythonPreference = scientificComputing.languages[PYTHON_LANGUAGE_ID] ?? {
    enabled: false,
    executable: "",
  };
  const ensurePythonEnabled = useCallback(async () => {
    if (pythonPreference.enabled) return true;
    const result = await updateEnvironmentSettings({
      environmentId: props.environmentId,
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: {
              [PYTHON_LANGUAGE_ID]: { ...pythonPreference, enabled: true },
            },
          },
        },
      },
    });
    return result._tag === "Success";
  }, [props.environmentId, pythonPreference, updateEnvironmentSettings]);

  const allSessions = useMemo(() => {
    return mergeComputeSessionRecords(
      sessions.data ?? [],
      exactSession.data === null ? [] : [exactSession.data],
      events.data?.sessions.values() ?? [],
    ).toSorted(
      (left, right) =>
        right.createdAt.localeCompare(left.createdAt) ||
        right.sessionId.localeCompare(left.sessionId),
    );
  }, [events.data?.sessions, exactSession.data, sessions.data]);
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
  const contextSessions = useMemo(() => {
    if (props.contextId === undefined) return allSessions;
    if (contextBinding?.sessionId === null || contextBinding?.sessionId === undefined) return [];
    return allSessions.filter((session) => session.sessionId === contextBinding.sessionId);
  }, [allSessions, contextBinding, props.contextId]);
  const capacitySessions = useMemo(
    () =>
      allSessions.filter(
        (session) =>
          !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status) &&
          session.sessionId !== contextBinding?.sessionId,
      ),
    [allSessions, contextBinding?.sessionId],
  );
  const selectedOverviewSession =
    props.contextId === undefined
      ? allSessions.find((session) => session.sessionId === selectedSessionId)
      : undefined;
  const liveSession =
    selectedOverviewSession !== undefined &&
    !TERMINAL_COMPUTE_SESSION_STATUSES.has(selectedOverviewSession.status)
      ? selectedOverviewSession
      : (contextSessions.find(
          (session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
        ) ?? null);
  const selectedSession =
    contextSessions.find((session) => session.sessionId === selectedSessionId) ??
    liveSession ??
    contextSessions[0] ??
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
      .toSorted(
        (left, right) =>
          right.request.submittedAt.localeCompare(left.request.submittedAt) ||
          right.request.executionId.localeCompare(left.request.executionId),
      );
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
  const selectedIsCurrentResult =
    selectedSession?.sessionId === contextSessions[0]?.sessionId &&
    selectedExecution?.request.executionId === selectedExecutions[0]?.request.executionId;
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
    if (props.focusSessionId) setSelectedSessionId(props.focusSessionId);
    if (props.focusExecutionId) setSelectedExecutionId(props.focusExecutionId);
  }, [props.focusExecutionId, props.focusSessionId]);

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
    refreshProjectFiles(props.environmentId, props.cwd);
    // Refresh ordinary workspace state once after a newly terminal execution.
  }, [props.cwd, props.environmentId, selectedExecutions]);

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
        sessions.refresh();
        events.refresh();
        return;
      }
      if (!isAtomCommandInterrupted(result)) {
        operationFailure(`Unable to stop ${session.label}`, result);
      }
    },
    [events, props.cwd, props.environmentId, sessions, stopSession, stoppingUnusedSession],
  );

  const confirmFailedStart = useCallback(
    async (sessionId: ComputeSessionId, generation: ComputeSessionRecord["generation"]) => {
      if (props.contextId === undefined) return;
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

  const handleStart = async () => {
    if (selectedRuntime === null) return;
    const context =
      props.contextId === undefined
        ? null
        : (getComputeContext(props.contextId) ??
          ensureComputeContext({
            contextId: props.contextId,
            environmentId: props.environmentId,
            cwd: props.cwd,
            ownerKey: `${props.environmentId}:${props.cwd}:${props.contextId}`,
          }));
    if (
      (context?.lifecycle === "starting" && !capacityBlocked && !canRetryStart) ||
      context?.lifecycle === "live" ||
      context?.lifecycle === "closing" ||
      context?.lifecycle === "close-failed"
    ) {
      return;
    }
    const sessionId =
      context?.lifecycle === "terminal" || context?.sessionId === null
        ? ComputeSessionId.make(randomUUID())
        : (context?.sessionId ?? ComputeSessionId.make(randomUUID()));
    const requestedGeneration =
      context?.lifecycle === "terminal" || context?.sessionId === null
        ? INITIAL_COMPUTE_CONTEXT_GENERATION
        : (context?.generation ?? INITIAL_COMPUTE_CONTEXT_GENERATION);
    if (props.contextId !== undefined) {
      const reserved = useComputeContextStore.getState().reserveSession({
        contextId: props.contextId,
        sessionId,
        generation: requestedGeneration,
      });
      if (!reserved) return;
    }
    setStartRetryAvailable(false);
    setOperation("start");
    const result = await startSession({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId,
        languageId: selectedRuntime.language.descriptor.languageId,
        executable: runtimeKey === "" ? null : selectedRuntime.candidate.profile.executable,
      },
    });
    setOperation((current) => (current === "start" ? null : current));
    if (result._tag === "Success") {
      setStartRetryAvailable(false);
      setCapacityBlocked(false);
      if (
        props.contextId !== undefined &&
        !useComputeContextStore.getState().bindSession({
          contextId: props.contextId,
          sessionId: result.value.sessionId,
          generation: result.value.generation,
        })
      ) {
        const current = getComputeContext(props.contextId);
        if (
          current?.sessionId === result.value.sessionId &&
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
      setSelectedSessionId(result.value.sessionId);
      sessions.refresh();
    } else {
      const capacityRejected = isComputeCapacityReachedError(squashAtomCommandFailure(result));
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
      if (!isAtomCommandInterrupted(result)) {
        operationFailure("Unable to start compute", result);
        runtimes.refresh();
        sessions.refresh();
      }
    }
  };

  const runSessionCommand = async (
    kind: "interrupt" | "restart" | "stop",
    target = liveSession,
  ) => {
    if (target === null) return;
    if (
      props.contextId !== undefined &&
      getComputeContext(props.contextId)?.sessionId !== target.sessionId
    ) {
      toastManager.add({
        type: "info",
        title: "The compute session changed",
        description: "Choose the intended session again.",
      });
      return;
    }
    setOperation(kind);
    if (kind === "stop" && props.contextId !== undefined) {
      await closeComputeContext({ contextId: props.contextId, stopSession, getSession });
      setOperation((current) => (current === kind ? null : current));
      sessions.refresh();
      executions.refresh();
      return;
    }
    const command =
      kind === "interrupt" ? interruptSession : kind === "restart" ? restartSession : stopSession;
    const result = await command({
      environmentId: props.environmentId,
      input: {
        cwd: props.cwd,
        sessionId: target.sessionId,
        expectedGeneration: target.generation,
      },
    });
    setOperation((current) => (current === kind ? null : current));
    if (result._tag === "Success" && props.contextId !== undefined) {
      if (kind === "stop") {
        useComputeContextStore.getState().markSessionTerminal({
          contextId: props.contextId,
          sessionId: result.value.sessionId,
          generation: result.value.generation,
        });
      } else {
        useComputeContextStore.getState().bindSession({
          contextId: props.contextId,
          sessionId: result.value.sessionId,
          generation: result.value.generation,
        });
      }
    }
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
    const confirmation = sessionConfirmation;
    if (confirmation === null) return;
    setSessionConfirmation(null);
    void runSessionCommand(confirmation.kind, confirmation.session);
  };

  const sessionConfirmationAnchor = useMemo(() => {
    if (sessionConfirmation === null) return undefined;
    const { x, y, width, height } = sessionConfirmation.anchorRect;
    return {
      getBoundingClientRect: () => ({
        x,
        y,
        top: y,
        right: x + width,
        bottom: y + height,
        left: x,
        width,
        height,
      }),
    };
  }, [sessionConfirmation]);

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background" aria-label="Scientific results">
      <header className="flex min-h-12 shrink-0 flex-wrap items-center gap-2 border-b border-border/60 px-3 py-1">
        <div className="min-w-0 flex-1">
          <div
            className="flex flex-wrap items-center gap-1"
            role="tablist"
            aria-label="Compute view"
          >
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
            {!props.embedded && contextBinding !== null ? (
              <span
                className={cn(
                  "max-w-52 truncate text-[11px] text-muted-foreground",
                  contextBinding.lifecycle === "close-failed" && "text-destructive",
                )}
                aria-label={contextBinding.closeError ?? undefined}
              >
                {selectedSession
                  ? computeSessionOwnerLabel(selectedSession, props.environmentId, props.cwd)
                  : (contextBinding.relativePath ?? "Compute context")}{" "}
                · {statusLabel(contextBinding.lifecycle)}
              </span>
            ) : selectedSession && !props.embedded ? (
              <span className="text-[11px] capitalize text-muted-foreground">
                {statusLabel(selectedSession.status)}
                {selectedSession.status === "ready" ? ` · ${selectedSession.activity}` : ""}
              </span>
            ) : null}
            {capacityBlocked ? (
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      className="h-6 max-w-48 px-1.5 text-[11px] font-normal text-warning"
                      disabled={stoppingUnusedSession !== null}
                      aria-label="Choose a compute session to stop"
                    />
                  }
                >
                  Capacity · choose session
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
                        {statusLabel(session.status)}
                      </MenuItem>
                    ))
                  )}
                </MenuPopup>
              </Menu>
            ) : null}
          </div>
          {contextSessions.length > (props.embedded ? 1 : 0) ? (
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
                        ? `${computeSessionOwnerLabel(selectedSession, props.environmentId, props.cwd)} · ${statusLabel(selectedSession.status)}`
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
                  {contextSessions.map((session) => (
                    <MenuRadioItem
                      key={session.sessionId}
                      value={session.sessionId}
                      className="min-h-7 py-1 sm:text-xs"
                    >
                      {computeSessionOwnerLabel(session, props.environmentId, props.cwd)} ·{" "}
                      {new Date(session.createdAt).toLocaleString()} · {statusLabel(session.status)}
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
        {!props.embedded && props.contextId !== undefined && allSessions.length > 0 ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Project compute history"
            title="Project compute history"
            onClick={() =>
              useRightPanelStore
                .getState()
                .openScient(props.threadRef, scientComputeSurface({ cwd: props.cwd }))
            }
          >
            <History />
          </Button>
        ) : null}
        {liveSession ? (
          <div className="flex flex-wrap items-center gap-1">
            {!props.embedded && props.contextId !== undefined ? (
              <ComputeSavedFileAction
                contextId={props.contextId}
                session={liveSession}
                environmentId={props.environmentId}
                threadRef={props.threadRef}
                cwd={props.cwd}
                disabled={
                  liveSession.status !== "ready" ||
                  operation !== null ||
                  contextBinding?.lifecycle !== "live"
                }
                onSubmitted={(execution) => {
                  setSelectedSessionId(execution.request.sessionId);
                  setSelectedExecutionId(execution.request.executionId);
                  setPanelView("results");
                  sessions.refresh();
                  executions.refresh();
                }}
              />
            ) : null}
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
                disabled={
                  operation !== null ||
                  contextBinding?.lifecycle === "closing" ||
                  contextBinding?.lifecycle === "close-failed"
                }
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
                    disabled={
                      operation === "stop" ||
                      contextBinding?.lifecycle === "closing" ||
                      contextBinding?.lifecycle === "close-failed"
                    }
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
                <MenuItem
                  disabled={operation !== null || liveSession?.status !== "ready"}
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setSessionConfirmation({
                      kind: "restart",
                      session: liveSession,
                      anchorRect: {
                        x: bounds.right,
                        y: bounds.top,
                        width: 0,
                        height: bounds.height,
                      },
                    });
                  }}
                >
                  <RotateCcw />
                  Restart session
                </MenuItem>
                <MenuSeparator />
                <MenuItem
                  variant="destructive"
                  onClick={(event) => {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setSessionConfirmation({
                      kind: "stop",
                      session: liveSession,
                      anchorRect: {
                        x: bounds.right,
                        y: bounds.top,
                        width: 0,
                        height: bounds.height,
                      },
                    });
                  }}
                >
                  <Power />
                  Stop session
                </MenuItem>
              </MenuPopup>
            </Menu>
          </div>
        ) : !props.embedded &&
          props.contextId !== undefined &&
          contextSessions.length > 0 &&
          selectedRuntime !== null ? (
          <Button
            size="xs"
            variant="outline"
            disabled={operation !== null}
            onClick={() => void handleStart()}
          >
            {operation === "start" ? <LoaderCircle className="animate-spin" /> : <Play />}
            Start new session
          </Button>
        ) : !props.embedded && contextSessions.length > 0 && !runtimes.isPending ? (
          <Button
            size="xs"
            variant="ghost-muted"
            render={
              <Link
                to="/settings/scientific-computing"
                search={{ environmentId: props.environmentId }}
              />
            }
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

      {contextBinding?.lifecycle === "close-failed" ? (
        <div className="flex items-center gap-2 border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {contextBinding.closeError ?? "Compute tab close was not confirmed."}
          </span>
          {props.onRetryClose ? (
            <Button size="xs" variant="outline" onClick={props.onRetryClose}>
              Retry close
            </Button>
          ) : null}
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
                    : "Run code from a source file to begin this session."}
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
                    allowFigureFollowing={selectedIsCurrentResult}
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
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-y-auto px-4 pb-6 pt-12">
          <div className="w-full max-w-md text-center">
            {props.embedded ? (
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                {contextBinding?.lifecycle === "starting" ? (
                  <>
                    <LoaderCircle className="size-3.5 animate-spin" /> Starting…
                  </>
                ) : contextBinding?.lifecycle === "closing" ? (
                  <>
                    <LoaderCircle className="size-3.5 animate-spin" /> Stopping…
                  </>
                ) : (
                  <>
                    <Button
                      size="xs"
                      variant="outline"
                      className="h-6 px-2"
                      onClick={props.onRunSource}
                    >
                      <Play /> Run
                    </Button>
                    <span>to see results.</span>
                  </>
                )}
              </div>
            ) : props.contextId === undefined ? (
              <p className="text-sm text-muted-foreground">No compute history yet.</p>
            ) : runtimes.isPending ? (
              <LoaderCircle className="mx-auto size-5 animate-spin text-muted-foreground" />
            ) : readyRuntimes.length === 0 ? (
              pythonLanguage?.managedRuntime &&
              (props.sourceLanguageId === undefined || props.sourceLanguageId === "python") ? (
                <div className="text-left">
                  <p className="text-center text-sm font-medium">Set up scientific computing</p>
                  <p className="mx-auto mt-1 max-w-lg text-center text-xs leading-relaxed text-muted-foreground">
                    Set up a private Scientific Python here, or choose an existing environment in
                    Settings.
                  </p>
                  <ManagedRuntimeCard
                    environmentId={props.environmentId}
                    language={pythonLanguage}
                    enabled={pythonPreference.enabled}
                    ensureEnabled={ensurePythonEnabled}
                  />
                  <div className="mt-3 text-center">
                    <Button
                      size="xs"
                      variant="ghost-muted"
                      render={
                        <Link
                          to="/settings/scientific-computing"
                          search={{ environmentId: props.environmentId }}
                        />
                      }
                    >
                      <Settings2 /> Use an existing environment
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <CircleAlert className="mx-auto size-5 text-muted-foreground" />
                  <p className="mt-3 text-sm font-medium">No compute runtime is ready</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                    Enable a language and choose an existing runtime in Scientific Computing
                    settings.
                  </p>
                  <Button
                    className="mt-4"
                    size="sm"
                    variant="outline"
                    render={
                      <Link
                        to="/settings/scientific-computing"
                        search={{ environmentId: props.environmentId }}
                      />
                    }
                  >
                    <Settings2 /> Scientific Computing settings
                  </Button>
                </>
              )
            ) : (
              <>
                <p className="text-sm font-medium">Start a scientific session</p>
                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">
                  This Compute tab owns its own session. Past runs remain in history.
                </p>
                <p className="mx-auto mt-1 max-w-sm text-[11px] leading-relaxed text-muted-foreground/80">
                  Code runs unsandboxed with this server&apos;s filesystem and network access.
                </p>
                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                  {readyRuntimes.length > 1 || selectedRuntime === null ? (
                    <Select
                      value={selectedRuntime?.key ?? ""}
                      onValueChange={(value) => setRuntimeKey(value ?? "")}
                    >
                      <SelectTrigger
                        size="xs"
                        className="w-fit min-w-0 max-w-full gap-1.5"
                        aria-label="Runtime"
                      >
                        <SelectValue className="max-w-56">
                          {selectedRuntime?.candidate.profile.displayName ?? "Choose runtime"}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectPopup alignItemWithTrigger={false}>
                        {readyRuntimes.map((runtime) => (
                          <SelectItem
                            key={runtime.key}
                            value={runtime.key}
                            hideIndicator
                            className="text-xs"
                          >
                            {runtime.candidate.profile.displayName}
                          </SelectItem>
                        ))}
                      </SelectPopup>
                    </Select>
                  ) : null}
                  <Button
                    size="xs"
                    disabled={
                      operation !== null ||
                      selectedRuntime === null ||
                      stoppingUnusedSession !== null ||
                      (contextBinding?.lifecycle === "starting" &&
                        !capacityBlocked &&
                        !canRetryStart)
                    }
                    onClick={() => void handleStart()}
                  >
                    {operation === "start" ? <LoaderCircle className="animate-spin" /> : <Play />}
                    {operation === "start"
                      ? "Starting…"
                      : canRetryStart
                        ? "Retry start"
                        : "Start session"}
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
      <Popover
        open={sessionConfirmation !== null}
        modal
        onOpenChange={(open) => {
          if (!open) setSessionConfirmation(null);
        }}
      >
        <PopoverPopup
          anchor={sessionConfirmationAnchor}
          align="center"
          className="w-72 max-w-[calc(100vw-1rem)]"
          role="alertdialog"
          side="left"
          sideOffset={4}
          viewportClassName="p-0"
        >
          <div className="p-3">
            <PopoverTitle className="text-sm">
              {sessionConfirmation?.kind === "restart"
                ? "Restart this session?"
                : "Stop this session?"}
            </PopoverTitle>
            <PopoverDescription className="mt-1 text-xs leading-5">
              {sessionConfirmation?.kind === "restart"
                ? "Cancels queued work and clears variables. Run history stays."
                : "Closes the runtime and clears its variables. Run history stays."}
            </PopoverDescription>
            <div className="mt-3 flex justify-end gap-1.5">
              <Button size="xs" variant="ghost" onClick={() => setSessionConfirmation(null)}>
                Cancel
              </Button>
              <Button
                size="xs"
                variant={sessionConfirmation?.kind === "stop" ? "destructive" : "default"}
                onClick={confirmSessionCommand}
              >
                {sessionConfirmation?.kind === "restart" ? "Restart session" : "Stop session"}
              </Button>
            </div>
          </div>
        </PopoverPopup>
      </Popover>
    </section>
  );
}
