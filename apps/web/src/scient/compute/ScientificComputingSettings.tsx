import { ExternalLinkIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeRuntimeVerification,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { ComputeLanguageDescriptor, ComputeLanguageId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { useEnvironmentSettings } from "~/hooks/useSettings";
import { serverEnvironment } from "~/state/server";
import { useEnvironment, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import {
  useComputeManagedRuntime,
  ManagedRuntimeNotice,
  ManagedRuntimeActions,
  type ComputeManagedRuntimeController,
} from "./ComputeManagedRuntimeControls";
import {
  computeCurrentRuntimeSummary,
  computeRuntimePickerLabel,
  defaultComputeInstallation,
  selectExistingComputeInstallation,
} from "./computeInstallationSettingsModel";

function LanguageRuntimeSummary({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading: boolean;
  refreshing: boolean;
}) {
  const languageId = language.descriptor.languageId;
  const isMatlab = languageId === "matlab";
  const runtime = useComputeManagedRuntime({
    environmentId,
    languageId,
    initialStatus: language.managedRuntime,
    ensureEnabled: async () =>
      preference.enabled || (await onChange({ ...preference, enabled: true })),
  });
  const summary = computeCurrentRuntimeSummary({
    language,
    preference,
    managed: runtime.status,
  });
  const disabled = Boolean(loading || refreshing || runtime.busy || !environmentId);
  const setup = () => {
    void runtime.act(runtime.status?.installed ? (isMatlab ? "use-managed" : "repair") : "install");
  };
  const showManagedNotice =
    runtime.status?.operation != null ||
    (Boolean(runtime.failure) &&
      (summary.kind === "setup" ||
        summary.kind === "repair" ||
        (!isMatlab && runtime.status?.selection === "managed")));
  const story = loading
    ? "Checking…"
    : summary.kind === "ready" || summary.kind === "repair"
      ? `${summary.title} · ${summary.detail}`
      : summary.detail;
  const control = (() => {
    if (loading || summary.kind === "ready") return null;
    if (summary.kind === "setup" || summary.kind === "repair") {
      return (
        <Button size="sm" disabled={disabled} onClick={setup}>
          {summary.kind === "repair" ? "Repair" : "Set up Python"}
        </Button>
      );
    }
    if (summary.kind === "connect") {
      return (
        <Button size="sm" disabled={disabled} onClick={setup}>
          Connect MATLAB
        </Button>
      );
    }
    if (summary.kind === "missing") {
      return (
        <Button
          size="sm"
          variant="ghost"
          render={
            <a
              href="https://www.mathworks.com/products/matlab.html"
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          Get MATLAB <ExternalLinkIcon />
        </Button>
      );
    }
    return null;
  })();
  return (
    <SettingsRow
      id={`${languageId}-runtime`}
      title={language.descriptor.displayName}
      description={<span data-compute-summary={languageId}>{story}</span>}
      control={control}
    >
      {showManagedNotice ? <ManagedRuntimeNotice runtime={runtime} /> : null}
      <details className="mt-2">
        <summary className="w-fit cursor-pointer text-xs text-muted-foreground">
          Change runtime
        </summary>
        <LanguageRuntimeRecovery
          language={language}
          preference={preference}
          onChange={onChange}
          environmentId={environmentId}
          loading={loading}
          refreshing={refreshing}
          runtime={runtime}
        />
      </details>
    </SettingsRow>
  );
}

function LanguageRuntimeRecovery({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
  runtime,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading: boolean;
  refreshing: boolean;
  runtime: ComputeManagedRuntimeController;
}) {
  const languageId = language.descriptor.languageId;
  const isPython = languageId === "python";
  const isMatlab = languageId === "matlab";
  const [pathOpen, setPathOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectionFailure, setSelectionFailure] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ComputeRuntimeVerification | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const selectionLock = useRef(false);
  const selectedInstallation = defaultComputeInstallation(language, preference, runtime.status);
  const managedInstallation = language.installations.find(
    (installation) => installation.source === "managed",
  );
  const disabled = Boolean(
    loading || refreshing || selecting || testing || runtime.busy || !environmentId,
  );
  const helperOwner = runtime.status?.installationExecutable;
  const helperNeedsRetarget =
    isMatlab &&
    runtime.status?.installed &&
    helperOwner &&
    helperOwner !== selectedInstallation?.executable;
  const hasExplicitSelection =
    Boolean(preference.executable.trim()) || (isPython && runtime.status?.selection === "managed");
  const helperCanRepair = !isMatlab || selectedInstallation?.executable === helperOwner;
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const testPassed = testResult?.readiness === "ready" && testResult.connection === "verified";

  const select = async (executable: string | null) => {
    if (selectionLock.current || runtime.busy || loading || refreshing) return;
    selectionLock.current = true;
    setSelecting(true);
    setSelectionFailure(null);
    setTestResult(null);
    setTestError(null);
    try {
      if (executable !== null && executable === managedInstallation?.executable) {
        if (!(await runtime.act("use-managed")))
          throw new Error("Scient-managed Python could not be selected. Try again.");
      } else {
        await selectExistingComputeInstallation({
          executable: executable ?? "",
          preference,
          releaseManaged: isPython && runtime.status?.selection === "managed",
          save: onChange,
          useExisting: async () => {
            if (!(await runtime.act("use-existing")))
              throw new Error(
                "Scient-managed Python is still selected. Try switching again when its current operation finishes.",
              );
          },
        });
      }
      setPathOpen(false);
      setPathDraft("");
    } catch (cause) {
      setSelectionFailure(
        cause instanceof Error ? cause.message : "The installation could not be selected.",
      );
    } finally {
      selectionLock.current = false;
      setSelecting(false);
    }
  };

  const runTest = async () => {
    if (!environmentId || !selectedInstallation || testing || loading || refreshing) return;
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    const result = await verifyRuntime({
      environmentId,
      input: { cwd: null, languageId, executable: selectedInstallation.executable },
    });
    setTesting(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setTestError(
        failure instanceof Error ? failure.message : "The connection could not be verified.",
      );
      return;
    }
    setTestResult(result.value);
    if (result.value.readiness !== "ready" || result.value.connection !== "verified") {
      setTestError(
        result.value.message ??
          "The connection could not be verified. Scient did not start a test session.",
      );
    }
  };

  return (
    <div className="mt-3 space-y-2" data-compute-recovery={languageId}>
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          Enable {language.descriptor.displayName}
        </span>
        <Switch
          checked={preference.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => void onChange({ ...preference, enabled })}
          aria-label={`Enable ${language.descriptor.displayName}`}
        />
      </div>
      {loading ? (
        <p className="text-xs text-muted-foreground" role="status">
          Checking…
        </p>
      ) : language.installations.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {preference.enabled ? "No installation detected" : "Disabled"}
        </p>
      ) : (
        <div className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
          <span className="text-xs text-muted-foreground">For new sessions</span>
          <Select
            value={selectedInstallation?.executable ?? null}
            onValueChange={(value) => {
              if (!value || value === selectedInstallation?.executable) return;
              void select(value);
            }}
            disabled={disabled || !preference.enabled}
          >
            <SelectTrigger
              size="sm"
              className="w-auto max-w-52"
              aria-label={`Choose ${language.descriptor.displayName} runtime`}
              title={selectedInstallation?.executable}
              data-compute-runtime={selectedInstallation?.executable ?? ""}
            >
              <SelectValue>
                {selectedInstallation
                  ? computeRuntimePickerLabel(selectedInstallation, language.descriptor.displayName)
                  : "Choose a runtime"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false} matchTriggerWidth={false}>
              {language.installations.map((installation) => (
                <SelectItem
                  key={installation.executable}
                  hideIndicator
                  value={installation.executable}
                  data-compute-runtime={installation.executable}
                >
                  {computeRuntimePickerLabel(installation, language.descriptor.displayName)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      )}
      {selectedInstallation?.problem ? (
        <p className="text-xs text-destructive" role="alert">
          {selectedInstallation.problem}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-0.5" data-compute-actions={languageId}>
        {preference.enabled && selectedInstallation ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="xs"
                  variant="ghost-muted"
                  disabled={disabled}
                  title="Starts and closes a test session."
                  onClick={() => void runTest()}
                />
              }
            >
              {testing ? "Testing…" : testPassed ? "Test passed" : "Test"}
            </TooltipTrigger>
            <TooltipPopup>
              Starts and closes a test session. Repair is not the recovery for a failed Test.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <ManagedRuntimeActions
          className="contents"
          runtime={runtime}
          connection={isMatlab}
          maintenanceOnly
          canProvision={!isMatlab || helperCanRepair}
          disabled={selecting || refreshing || !environmentId}
        />
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={disabled || !preference.enabled}
          onClick={() => {
            setPathOpen(!pathOpen);
            setPathDraft("");
            setSelectionFailure(null);
          }}
        >
          Use another path…
        </Button>
        {hasExplicitSelection ? (
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={disabled || !preference.enabled}
            onClick={() => void select(null)}
          >
            Reset to automatic
          </Button>
        ) : null}
      </div>
      {testError ? (
        <p className="text-xs text-destructive" role="alert">
          {testError}
        </p>
      ) : null}
      {helperNeedsRetarget ? (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">
            The connection helper belongs to a different MATLAB. Set up a connection for this one.
          </p>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => void runtime.act("repair")}
          >
            Set up connection
          </Button>
        </div>
      ) : null}
      {pathOpen ? (
        <form
          className="flex min-w-0 items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (pathDraft.trim()) void select(pathDraft.trim());
          }}
        >
          <Input
            nativeInput
            size="compact"
            className="min-w-0 flex-1"
            value={pathDraft}
            disabled={disabled}
            placeholder="Executable path"
            aria-label={`${language.descriptor.displayName} executable path`}
            onChange={(event) => setPathDraft(event.currentTarget.value)}
          />
          <Button
            size="xs"
            variant="outline"
            type="submit"
            disabled={disabled || !pathDraft.trim()}
          >
            Use
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={selecting}
            onClick={() => setPathOpen(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {selectionFailure ? (
        <p className="text-xs text-destructive" role="alert">
          {selectionFailure}
        </p>
      ) : null}
      <ManagedRuntimeNotice runtime={runtime} />
      {language.failureMessage ? (
        <p className="text-xs text-destructive" role="alert">
          {language.failureMessage}
        </p>
      ) : null}
    </div>
  );
}

const PENDING_RUNTIME_DESCRIPTORS: ReadonlyArray<ComputeLanguageDescriptor> = [
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
  ComputeLanguageDescriptor.make({
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
    sourceExtensions: [".m"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  }),
];

function pendingRuntimeInventory(
  preferences: Readonly<Record<string, ScientificComputingLanguageSettings>>,
): ReadonlyArray<ComputeLanguageRuntimeInventory> {
  return PENDING_RUNTIME_DESCRIPTORS.map((descriptor) => {
    const preference = preferences[descriptor.languageId] ?? { enabled: false, executable: "" };
    return {
      descriptor,
      enabled: preference.enabled,
      configuredExecutable: preference.executable || null,
      managedRuntime: null,
      toolkits: [],
      installations: [],
      failureMessage: null,
    };
  });
}

export function ScientificComputingSettings(
  props: { environmentId?: EnvironmentId | undefined } = {},
) {
  const primaryId = usePrimaryEnvironmentId();
  const environmentId = props.environmentId ?? primaryId;
  const environment = useEnvironment(environmentId);
  if (environmentId === null || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Scientific Computing">
          <p className="text-sm text-muted-foreground">
            This server is unavailable. Reconnect it to manage scientific runtimes.
          </p>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }
  return (
    <EnvironmentScientificComputingSettings
      key={environmentId}
      environmentId={environmentId}
      label={environment.label}
    />
  );
}

function EnvironmentScientificComputingSettings({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const preferences = useEnvironmentSettings(
    environmentId,
    (settings) => settings.scientificComputing,
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimeInventory, {
    reportFailure: false,
  });
  const [refreshing, setRefreshing] = useState(false);
  const [refreshFailure, setRefreshFailure] = useState<string | null>(null);
  const runtimesAtom = environmentId
    ? computeEnvironment.runtimeInventory({
        environmentId,
        input: {},
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);
  const inventoryPending = runtimes.data === undefined && runtimes.error === null;
  const displayedLanguages =
    runtimes.data?.languages ?? pendingRuntimeInventory(preferences.languages);

  const updateLanguage = async (
    languageId: ComputeLanguageRuntimeInventory["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    const result = await updateSettings({
      environmentId,
      input: {
        patch: {
          scientificComputing: {
            schemaVersion: 1,
            languages: { [languageId]: next },
          },
        },
      },
    });
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error ? failure.message : "The setting could not be saved.",
      );
      return false;
    }
    setRefreshFailure(null);
    return true;
  };

  const handleRefresh = useCallback(async () => {
    if (environmentId === null) return;
    setRefreshFailure(null);
    setRefreshing(true);
    const result = await refreshRuntimes({
      environmentId,
      input: {},
    });
    setRefreshing(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setRefreshFailure(
        failure instanceof Error
          ? failure.message
          : "Scient could not refresh scientific runtimes.",
      );
      return;
    }
    setRefreshFailure(null);
  }, [environmentId, refreshRuntimes]);

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        icon={<SigmaIcon className="size-4 text-muted-foreground" />}
        headerAction={
          <div className="flex items-center gap-1.5">
            <span className="hidden text-xs text-muted-foreground sm:inline">{label}</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    disabled={runtimes.isPending || refreshing}
                    aria-label="Refresh scientific runtimes"
                    onClick={() => void handleRefresh()}
                  >
                    <RefreshCwIcon
                      className={cn(runtimes.isPending || refreshing ? "animate-spin" : undefined)}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top">Refresh runtimes</TooltipPopup>
            </Tooltip>
          </div>
        }
      >
        {displayedLanguages.map((language) => {
          const preference = preferences.languages[language.descriptor.languageId] ?? {
            enabled: false,
            executable: language.configuredExecutable ?? "",
          };
          return (
            <LanguageRuntimeSummary
              key={language.descriptor.languageId}
              language={language}
              preference={preference}
              onChange={(next) => updateLanguage(language.descriptor.languageId, next)}
              environmentId={environmentId}
              loading={inventoryPending}
              refreshing={refreshing}
            />
          );
        })}
        {(refreshFailure ?? runtimes.error) ? (
          <p className="px-4 py-3 text-xs text-destructive" role="alert">
            {refreshFailure ?? runtimes.error}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
