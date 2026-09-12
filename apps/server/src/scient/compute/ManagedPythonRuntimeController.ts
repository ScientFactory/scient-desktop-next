// @effect-diagnostics nodeBuiltinImport:off -- operation identities use host randomness.
import * as NodeCrypto from "node:crypto";

import {
  ComputeOperationError,
  type ComputeManagedRuntimeAction,
  type ComputeManagedRuntimeStatus,
  type ComputeToolkitId,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { ComputeRuntimeBinding } from "./ComputeSessionService.ts";
import type { makeManagedPythonEnvironmentManager } from "./ManagedPythonEnvironment.ts";
import {
  MANAGED_PYTHON_PROVISIONER_VERSION,
  MANAGED_PYTHON_TOOLKIT_REVISION,
  MANAGED_PYTHON_VERSION,
} from "./ManagedPythonProvisioner.ts";

type ManagedPythonManager = ReturnType<typeof makeManagedPythonEnvironmentManager>;
const isComputeOperationError = Schema.is(ComputeOperationError);

interface ActiveOperation {
  readonly action: ComputeManagedRuntimeAction;
  readonly controller: AbortController;
  readonly operationId: string;
  readonly startedAt: string;
  phase: NonNullable<ComputeManagedRuntimeStatus["operation"]>["phase"];
  downloadedBytes: number | null;
  totalBytes: number | null;
}

function operationError(message: string, cause?: unknown): ComputeOperationError {
  return new ComputeOperationError({
    operation: "manage",
    reason: "operation-failed",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function shortMessage(value: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  for (
    let current = value;
    current instanceof Error && messages.length < 3 && !seen.has(current);
    current = current.cause
  ) {
    seen.add(current);
    messages.push(current.message);
  }
  return (messages.join(" ") || "Scientific runtime setup failed.").slice(0, 4096);
}

export function makeManagedPythonRuntimeController(input: {
  readonly manager: ManagedPythonManager;
  readonly toolkitIds: ReadonlyArray<ComputeToolkitId>;
  readonly configuration?: {
    readonly displayName: string;
    readonly description: string;
    readonly toolkitRevision: string;
  };
}): NonNullable<ComputeRuntimeBinding["managedRuntime"]> & { readonly dispose: () => void } {
  const displayName = input.configuration?.displayName ?? "Scientific Python";
  const toolkitRevision = input.configuration?.toolkitRevision ?? MANAGED_PYTHON_TOOLKIT_REVISION;
  let operation: ActiveOperation | null = null;
  let failureMessage: string | null = null;

  const readStatus = async (): Promise<ComputeManagedRuntimeStatus> => {
    for (;;) {
      const operationSnapshot = operation;
      const current = await input.manager.inspect();
      if (operationSnapshot !== operation) continue;
      const active = current?.record.active ?? null;
      return {
        ...(input.configuration === undefined
          ? {}
          : {
              displayName,
              description: input.configuration.description,
            }),
        installed: current !== null,
        generationId: active?.generationId ?? null,
        selection: current?.record.selection ?? "existing",
        updateAvailable:
          active !== null &&
          (active.toolkitRevision !== toolkitRevision ||
            active.pythonVersion !== MANAGED_PYTHON_VERSION ||
            active.provisionerVersion !== MANAGED_PYTHON_PROVISIONER_VERSION),
        runtimeVersion: active === null ? null : `Python ${active.pythonVersion}`,
        toolkitRevision: active?.toolkitRevision ?? null,
        operation:
          operationSnapshot === null
            ? null
            : {
                operationId: operationSnapshot.operationId,
                action: operationSnapshot.action,
                phase: operationSnapshot.phase,
                startedAt: operationSnapshot.startedAt,
                downloadedBytes: operationSnapshot.downloadedBytes,
                totalBytes: operationSnapshot.totalBytes,
              },
        failureMessage:
          failureMessage ??
          (current !== null && !current.available
            ? `${displayName} is unavailable. Repair it or choose an existing environment.`
            : null),
      };
    }
  };

  const status = () =>
    Effect.tryPromise({
      try: readStatus,
      catch: (cause) => operationError(`Unable to inspect ${displayName}.`, cause),
    });

  const begin = async (
    action: Extract<ComputeManagedRuntimeAction, "install" | "update" | "repair" | "remove">,
  ): Promise<void> => {
    if (operation !== null) return;
    const current = await input.manager.inspect();
    // Two clients can cross the first check while inspection is in flight.
    // Recheck before publishing the operation so one server owns one mutation.
    if (operation !== null) return;
    if (action === "install" && current !== null) return;
    if (action === "update" && current !== null) {
      const active = current.record.active;
      if (
        active.toolkitRevision === toolkitRevision &&
        active.pythonVersion === MANAGED_PYTHON_VERSION &&
        active.provisionerVersion === MANAGED_PYTHON_PROVISIONER_VERSION
      ) {
        return;
      }
    }
    if ((action === "repair" || action === "update") && current === null) {
      throw operationError(`Set up ${displayName} before repairing or updating it.`);
    }
    if (action === "remove" && current === null) return;

    const controller = new AbortController();
    const activeOperation: ActiveOperation = {
      action,
      controller,
      operationId: NodeCrypto.randomUUID(),
      startedAt: DateTime.formatIso(DateTime.nowUnsafe()),
      phase: action === "remove" ? "removing" : "installing-python",
      downloadedBytes: null,
      totalBytes: null,
    };
    operation = activeOperation;
    failureMessage = null;

    const run =
      action === "remove"
        ? input.manager.remove()
        : input.manager[action === "repair" ? "repair" : "install"]({
            toolkitIds: input.toolkitIds,
            toolkitRevision,
            pythonVersion: MANAGED_PYTHON_VERSION,
            provisionerVersion: MANAGED_PYTHON_PROVISIONER_VERSION,
            signal: controller.signal,
            onProgress: (progress) => {
              if (operation !== activeOperation) return;
              activeOperation.phase = progress.phase;
              activeOperation.downloadedBytes = progress.downloadedBytes;
              activeOperation.totalBytes = progress.totalBytes;
            },
          });
    void run
      .then(() => {
        failureMessage = null;
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) failureMessage = shortMessage(cause);
      })
      .finally(() => {
        if (operation === activeOperation) operation = null;
      });
  };

  const manage = (action: ComputeManagedRuntimeAction) =>
    Effect.tryPromise({
      try: async () => {
        if (action === "use-managed" || action === "use-existing") {
          if (operation !== null) {
            throw operationError(`Wait for the current ${displayName} operation to finish.`);
          }
          await input.manager.select(action === "use-managed" ? "managed" : "existing");
          failureMessage = null;
        } else {
          await begin(action);
        }
        return await readStatus();
      },
      catch: (cause) =>
        isComputeOperationError(cause)
          ? cause
          : operationError(`Unable to manage ${displayName}.`, cause),
    });

  const cancel = () =>
    Effect.tryPromise({
      try: async () => {
        operation?.controller.abort();
        return await readStatus();
      },
      catch: (cause) => operationError(`Unable to cancel ${displayName} setup.`, cause),
    });

  return {
    isRemoving: () => operation?.action === "remove",
    status,
    manage,
    cancel,
    dispose: () => operation?.controller.abort(),
  };
}
