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
import { ChevronDown, LoaderCircle, Play } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { forwardRef, useCallback, useImperativeHandle, useMemo, useState } from "react";

import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "~/components/ui/menu";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";

import {
  pythonCell,
  pythonFile,
  pythonSelection,
  resolvePythonRunTarget,
  type PythonCodeSlice,
  type PythonTextRange,
} from "./pythonCells";
import { resolvePythonRuntimeToolbarState } from "./pythonComputeSurfaceModel";

type PythonRunKind = "selection" | "cell" | "file";

export interface PythonFileComputeActionsHandle {
  readonly runPrimary: (selection?: PythonTextRange | null) => void;
  readonly runCellAtLine: (line: number) => void;
}

interface PythonFileComputeActionsProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
  readonly contents: string;
  readonly sourceRevision: string;
  readonly sourcePending: boolean;
  readonly selection: { readonly start: number; readonly end: number } | null;
  readonly editorSelection: PythonTextRange | null;
  readonly onExecutionSubmitted: (executionId: ComputeExecutionId) => void;
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

export const PythonFileComputeActions = forwardRef<
  PythonFileComputeActionsHandle,
  PythonFileComputeActionsProps
>(function PythonFileComputeActions(props, ref) {
  const [operation, setOperation] = useState<PythonRunKind | null>(null);
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
  const startSession = useAtomCommand(computeEnvironment.startSession, { reportFailure: false });
  const submitExecution = useAtomCommand(computeEnvironment.submitExecution, {
    reportFailure: false,
  });

  const liveSession = useMemo(() => {
    const byId = new Map<string, ComputeSessionRecord>();
    for (const session of sessions.data ?? []) byId.set(session.sessionId, session);
    for (const session of events.data?.sessions.values() ?? []) {
      byId.set(session.sessionId, session);
    }
    return (
      [...byId.values()].find(
        (session) => !TERMINAL_COMPUTE_SESSION_STATUSES.has(session.status),
      ) ?? null
    );
  }, [events.data?.sessions, sessions.data]);
  const readyPython = useMemo(
    () =>
      runtimes.data?.languages
        .find((language) => language.descriptor.languageId === "python" && language.enabled)
        ?.runtimes.find((candidate) => candidate.verification.readiness === "ready") ?? null,
    [runtimes.data],
  );

  const run = useCallback(
    async (kind: PythonRunKind, slice: PythonCodeSlice | null) => {
      if (slice === null || operation !== null) return;
      setOperation(kind);

      let session = liveSession;
      if (session !== null && session.languageId !== "python") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Another language is active",
            description: "Stop the live compute session before running this Python file.",
          }),
        );
        setOperation(null);
        return;
      }
      if (session === null) {
        if (readyPython === null) {
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Python is not ready",
              description: "Enable and configure Python in Scientific Computing settings.",
            }),
          );
          setOperation(null);
          return;
        }
        const started = await startSession({
          environmentId: props.environmentId,
          input: {
            cwd: props.cwd,
            sessionId: ComputeSessionId.make(randomUUID()),
            languageId: readyPython.profile.languageId,
            executable: readyPython.profile.executable,
          },
        });
        if (started._tag !== "Success") {
          setOperation(null);
          if (!isAtomCommandInterrupted(started)) reportFailure("Unable to start Python", started);
          sessions.refresh();
          runtimes.refresh();
          return;
        }
        session = started.value;
        sessions.refresh();
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
        props.onExecutionSubmitted(executionId);
      } else if (!isAtomCommandInterrupted(submitted)) {
        reportFailure("Unable to run Python", submitted);
        sessions.refresh();
      }
    },
    [
      liveSession,
      operation,
      props.cwd,
      props.environmentId,
      props.onExecutionSubmitted,
      props.relativePath,
      props.sourcePending,
      props.sourceRevision,
      readyPython,
      runtimes,
      sessions,
      startSession,
      submitExecution,
    ],
  );

  const lineSelectionSlice =
    props.selection === null ? null : pythonSelection(props.contents, props.selection);
  const primary = resolvePythonRunTarget(props.contents, props.selection, props.editorSelection);
  const selectionSlice = primary.kind === "selection" ? primary.slice : lineSelectionSlice;
  const caretLine = props.editorSelection?.end.line;
  const cellSlice = caretLine === undefined ? null : pythonCell(props.contents, caretLine + 1);
  const fileSlice = pythonFile(props.contents);
  const busy = operation !== null;
  const runtimeToolbar = resolvePythonRuntimeToolbarState({
    liveSession,
    runtimeInspectionPending: runtimes.isPending,
    readyPythonAvailable: readyPython !== null,
  });

  useImperativeHandle(
    ref,
    () => ({
      runPrimary: (selection) => {
        const target = resolvePythonRunTarget(
          props.contents,
          props.selection,
          selection === undefined ? props.editorSelection : selection,
        );
        void run(target.kind, target.slice);
      },
      runCellAtLine: (line) => void run("cell", pythonCell(props.contents, line)),
    }),
    [props.contents, props.editorSelection, props.selection, run],
  );

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="min-w-0 flex-1">
        {runtimeToolbar.kind === "setup" ? (
          <Button
            size="xs"
            variant="ghost-muted"
            className="-ms-2 h-6 px-2 text-[11px] font-normal"
            title="Open Scientific Computing settings"
            render={<Link to="/settings/scientific-computing" />}
          >
            {runtimeToolbar.label}
          </Button>
        ) : (
          <span className="block truncate text-[11px] text-muted-foreground">
            {runtimeToolbar.label}
          </span>
        )}
      </div>
      <div className="flex shrink-0 items-center">
        <Button
          size="xs"
          className="rounded-r-none"
          disabled={busy || !runtimeToolbar.canRun || primary.slice === null}
          onClick={() => void run(primary.kind, primary.slice)}
        >
          {operation === primary.kind ? <LoaderCircle className="animate-spin" /> : <Play />}
          {primary.label}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                className="rounded-l-none border-l border-primary-foreground/20"
                disabled={busy || !runtimeToolbar.canRun}
                aria-label="Choose Python code to run"
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
          </MenuPopup>
        </Menu>
      </div>
    </div>
  );
});
