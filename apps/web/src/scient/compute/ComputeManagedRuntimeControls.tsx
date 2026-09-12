import { useRef, useState } from "react";
import { Download, LoaderCircle, Trash2, Wrench } from "lucide-react";
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
  const queried = useEnvironmentQuery(
    input.environmentId && input.initialStatus !== null
      ? computeEnvironment.managedRuntime({
          environmentId: input.environmentId,
          input: { languageId: input.languageId },
        })
      : null,
  );
  const status = queried.data ?? input.initialStatus;
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
    busy: pending || status?.operation != null || queried.isPending,
    failure: localFailure ?? queried.error ?? status?.failureMessage ?? null,
    act,
    cancel,
  };
}

export type ComputeManagedRuntimeController = ReturnType<typeof useComputeManagedRuntime>;

export function ManagedRuntimeNotice({ runtime }: { runtime: ComputeManagedRuntimeController }) {
  const progress = runtime.status && managedRuntimeOperationLabel(runtime.status);
  if (!progress && !runtime.failure) return null;
  return (
    <div className="space-y-1 text-xs">
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
      {runtime.failure ? (
        <p className="text-destructive" role="alert">
          {runtime.failure}
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
}: {
  runtime: ComputeManagedRuntimeController;
  connection?: boolean;
  canProvision?: boolean;
  disabled?: boolean;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = runtime.status;
  if (!status) return null;
  const displayName = connection ? "MATLAB connection helper" : "Scient-managed Python";
  const busy = disabled || runtime.busy;
  return (
    <>
      <div className="flex flex-wrap items-center gap-0.5">
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
