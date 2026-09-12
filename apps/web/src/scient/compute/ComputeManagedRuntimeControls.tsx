import { useRef, useState } from "react";
import {
  CheckIcon,
  ChevronDown,
  CopyIcon,
  Download,
  LoaderCircle,
  Trash2,
  Wrench,
} from "lucide-react";
import type {
  ComputeLanguageId,
  ComputeManagedRuntimeAction,
  ComputeManagedRuntimeStatus,
  EnvironmentId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { computeEnvironment } from "~/state/compute";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { computeRuntimeFailureHeadline } from "./computeFileSurfaceModel";

export function managedRuntimeOperationLabel(status: ComputeManagedRuntimeStatus): string | null {
  const operation = status.operation;
  if (!operation) return null;
  switch (operation.phase) {
    case "downloading": {
      if (operation.downloadedBytes === null || operation.totalBytes === null)
        return "Downloading the verified installer…";
      const downloaded = Math.max(0.1, operation.downloadedBytes / (1024 * 1024)).toFixed(1);
      const total = Math.max(0.1, operation.totalBytes / (1024 * 1024)).toFixed(1);
      return `Downloading the verified installer · ${downloaded} of ${total} MB`;
    }
    case "installing-python":
      return "Installing private Python…";
    case "installing-packages":
      return status.displayName
        ? "Preparing the connection helper…"
        : "Installing the locked scientific packages…";
    case "verifying":
      return status.displayName
        ? "Checking the connection helper…"
        : "Verifying Python, Jupyter, data, and figures…";
    case "removing":
      return `Removing ${status.displayName ?? "Scient-managed Python"}…`;
  }
}

export function useComputeManagedRuntime(input: {
  environmentId: EnvironmentId | null;
  languageId: ComputeLanguageId;
  initialStatus: ComputeManagedRuntimeStatus | null;
  ensureEnabled: () => Promise<boolean>;
}) {
  const manage = useAtomCommand(computeEnvironment.manageRuntime, { reportFailure: false });
  const cancelCommand = useAtomCommand(computeEnvironment.cancelManagedRuntime, {
    reportFailure: false,
  });
  // First-time file setup has no inventory status yet. Subscribe anyway so
  // Set up Python / Connect MATLAB can show progress on the file, not only in Settings.
  const queried = useEnvironmentQuery(
    input.environmentId
      ? computeEnvironment.managedRuntime({
          environmentId: input.environmentId,
          input: { languageId: input.languageId },
        })
      : null,
  );
  const [commandStatus, setCommandStatus] = useState<ComputeManagedRuntimeStatus | null>(null);
  const status = queried.data ?? commandStatus ?? input.initialStatus;
  const [pending, setPending] = useState(false);
  const [localFailure, setLocalFailure] = useState<string | null>(null);
  const inFlight = useRef(false);
  const act = async (action: ComputeManagedRuntimeAction): Promise<boolean> => {
    if (!input.environmentId || inFlight.current || status?.operation) return false;
    inFlight.current = true;
    setPending(true);
    setLocalFailure(null);
    try {
      if ((action === "install" || action === "use-managed") && !(await input.ensureEnabled())) {
        throw new Error("The language could not be enabled. Settings were not saved.");
      }
      const result = await manage({
        environmentId: input.environmentId,
        input: { languageId: input.languageId, action },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (result.value) setCommandStatus(result.value);
      return true;
    } catch (cause) {
      setLocalFailure(
        cause instanceof Error ? cause.message : "The installation could not be managed.",
      );
      return false;
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  const cancel = async () => {
    if (!input.environmentId) return;
    const result = await cancelCommand({
      environmentId: input.environmentId,
      input: { languageId: input.languageId },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setLocalFailure(failure instanceof Error ? failure.message : "Setup could not be cancelled.");
    }
  };
  return {
    status,
    busy: pending || status?.operation != null,
    failure: localFailure ?? queried.error ?? status?.failureMessage ?? null,
    act,
    cancel,
  };
}

export type ComputeManagedRuntimeController = ReturnType<typeof useComputeManagedRuntime>;

export function ManagedRuntimeNotice({
  runtime,
  languageId,
  variant = "block",
  onRetry,
}: {
  runtime: ComputeManagedRuntimeController;
  languageId?: string;
  variant?: "block" | "toolbar";
  onRetry?: () => void;
}) {
  const progress = runtime.status && managedRuntimeOperationLabel(runtime.status);
  const failure = runtime.failure;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "runtime error" });
  if (!progress && !failure) return null;
  if (variant === "toolbar") {
    const headline = failure
      ? computeRuntimeFailureHeadline(languageId ?? "python", failure)
      : null;
    return (
      <div
        className="flex min-w-0 items-center gap-0.5 overflow-hidden"
        data-compute-notice="toolbar"
      >
        {progress ? (
          <div className="flex min-w-0 items-center gap-1" role="status">
            <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden />
            <span className="truncate whitespace-nowrap text-xs text-muted-foreground">
              {progress}
            </span>
            {runtime.status?.operation?.action !== "remove" ? (
              <Button size="xs" variant="ghost-muted" onClick={() => void runtime.cancel()}>
                Cancel
              </Button>
            ) : null}
          </div>
        ) : null}
        {headline && failure ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className="min-w-0 truncate whitespace-nowrap text-left text-xs text-destructive"
                    role="alert"
                    onClick={onRetry}
                  />
                }
              >
                {headline}
              </TooltipTrigger>
              <TooltipPopup>{onRetry === undefined ? headline : `Retry ${headline}`}</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className="size-5 shrink-0"
                    aria-label="Copy error"
                    onClick={() => copyToClipboard(failure, undefined)}
                  />
                }
              >
                {isCopied ? (
                  <CheckIcon aria-hidden className="size-3" />
                ) : (
                  <CopyIcon aria-hidden className="size-3" />
                )}
              </TooltipTrigger>
              <TooltipPopup>Copy the full error</TooltipPopup>
            </Tooltip>
            <details className="relative shrink-0">
              <summary className="flex cursor-pointer list-none items-center text-muted-foreground marker:content-none [&::-webkit-details-marker]:hidden">
                <ChevronDown className="size-3" aria-hidden />
                <span className="sr-only">Error details</span>
              </summary>
              <pre className="absolute right-0 z-30 mt-1 max-h-40 w-80 max-w-[min(20rem,calc(100vw-2rem))] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-popover p-2 text-[11px] text-destructive shadow-md">
                {failure}
              </pre>
            </details>
          </>
        ) : null}
      </div>
    );
  }
  return (
    <div className="space-y-1 text-xs" data-compute-notice="block">
      {progress ? (
        <div className="flex flex-wrap items-center gap-1.5" role="status">
          <LoaderCircle className="size-3 animate-spin" aria-hidden />
          <span className="text-muted-foreground">{progress}</span>
          {runtime.status?.operation?.action !== "remove" ? (
            <Button size="xs" variant="ghost-muted" onClick={() => void runtime.cancel()}>
              Cancel
            </Button>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p className="text-destructive" role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

export function ManagedRuntimeActions({
  runtime,
  connection = false,
  canProvision = true,
  disabled = false,
  maintenanceOnly = false,
  className,
}: {
  runtime: ComputeManagedRuntimeController;
  connection?: boolean;
  canProvision?: boolean;
  disabled?: boolean;
  maintenanceOnly?: boolean;
  className?: string;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = runtime.status;
  if (!status) return null;
  const displayName = connection ? "MATLAB connection helper" : "Scient-managed Python";
  const busy = disabled || runtime.busy;
  if (maintenanceOnly && !status.installed) return null;
  return (
    <>
      <div className={cn("flex flex-wrap items-center gap-0.5", className)}>
        {!status.installed ? (
          <Button
            size="xs"
            disabled={busy || !canProvision}
            onClick={() => void runtime.act("install")}
          >
            <Download /> {connection ? "Set up connection" : "Set up Python"}
          </Button>
        ) : (
          <>
            {connection ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={busy || (!canProvision && status.selection !== "managed")}
                onClick={() =>
                  void runtime.act(status.selection === "managed" ? "use-existing" : "use-managed")
                }
              >
                {status.selection === "managed" ? "Use existing host" : "Use helper"}
              </Button>
            ) : null}
            {status.updateAvailable ? (
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || !canProvision}
                onClick={() => void runtime.act("update")}
              >
                <Download /> Update
              </Button>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy || !canProvision}
                    onClick={() => void runtime.act("repair")}
                  />
                }
              >
                <Wrench /> {connection ? "Repair connection" : "Repair"}
              </TooltipTrigger>
              <TooltipPopup>
                {canProvision
                  ? "Rebuild and verify the Scient-managed setup."
                  : "Select this installation before repairing its connection."}
              </TooltipPopup>
            </Tooltip>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => setConfirmRemove(true)}
              aria-label={`Remove ${displayName}`}
            >
              <Trash2 /> {connection ? "Remove helper" : "Remove"}
            </Button>
          </>
        )}
      </div>
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              {connection
                ? "This removes Scient’s connection helper. Your MATLAB installation and license are untouched."
                : "This removes Scient’s private Python environment. System installations and project environments are untouched."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setConfirmRemove(false);
                void runtime.act("remove");
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
