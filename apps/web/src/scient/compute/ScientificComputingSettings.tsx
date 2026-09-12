import { ExternalLinkIcon, RefreshCwIcon, SigmaIcon } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import type {
  ComputeLanguageRuntimeInventory,
  ComputeLanguageRuntimeInspection,
  EnvironmentId,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import { ComputeLanguageId } from "@t3tools/contracts";
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
import { Switch } from "~/components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { SettingsPageContainer, SettingsSection } from "~/components/settings/settingsLayout";
import { ComputeInstallationRow } from "./ComputeInstallationRow";
import {
  useComputeManagedRuntime,
  ManagedRuntimeNotice,
  ManagedRuntimeActions,
} from "./ComputeManagedRuntimeControls";
import {
  defaultComputeInstallation,
  selectExistingComputeInstallation,
} from "./computeInstallationSettingsModel";

export function ManagedRuntimeCard(props: {
  readonly environmentId: EnvironmentId | null;
  readonly language: ComputeLanguageRuntimeInspection | ComputeLanguageRuntimeInventory;
  readonly enabled: boolean;
  readonly ensureEnabled: () => Promise<boolean>;
}) {
  const runtime = useComputeManagedRuntime({
    environmentId: props.environmentId,
    languageId: props.language.descriptor.languageId,
    initialStatus: props.language.managedRuntime,
    ensureEnabled: props.ensureEnabled,
  });
  const status = runtime.status;
  if (!status) return null;
  const isConnection = props.language.descriptor.languageId === "matlab";
  const existingReady =
    "runtimes" in props.language
      ? props.language.runtimes.some(
          ({ profile, verification }) =>
            profile.source !== "managed" && verification.readiness === "ready",
        )
      : props.language.installations.some(
          (installation) => installation.source !== "managed" && installation.problem === null,
        );
  return (
    <div className="@container/managed-runtime mt-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex flex-col gap-2 @[32rem]/managed-runtime:flex-row @[32rem]/managed-runtime:items-start @[32rem]/managed-runtime:justify-between">
        <div className="min-w-0 space-y-2">
          <p className="text-sm font-medium">{status.displayName ?? "Scientific Python"}</p>
          <ManagedRuntimeNotice runtime={runtime} />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {!isConnection &&
          status.installed &&
          status.selection === "managed" &&
          props.enabled &&
          (existingReady || isConnection) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={runtime.busy}
              onClick={() => void runtime.act("use-existing")}
            >
              Use existing
            </Button>
          ) : !isConnection &&
            status.installed &&
            (status.selection !== "managed" || !props.enabled) ? (
            <Button
              size="xs"
              disabled={runtime.busy}
              onClick={() => void runtime.act("use-managed")}
            >
              Use
            </Button>
          ) : null}
          <ManagedRuntimeActions runtime={runtime} connection={isConnection} />
        </div>
      </div>
    </div>
  );
}

function LanguageSettingsRow({
  language,
  preference,
  onChange,
  environmentId,
  loading,
  refreshing,
  refreshRevision,
}: {
  language: ComputeLanguageRuntimeInventory;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => Promise<boolean>;
  environmentId: EnvironmentId | null;
  loading?: boolean;
  refreshing: boolean;
  refreshRevision: number;
}) {
  const languageId = language.descriptor.languageId;
  const isPython = languageId === "python";
  const isMatlab = languageId === "matlab";
  const runtime = useComputeManagedRuntime({
    environmentId,
    languageId,
    initialStatus: language.managedRuntime,
    ensureEnabled: async () =>
      preference.enabled || (await onChange({ ...preference, enabled: true })),
  });
  const verifyRuntime = useAtomCommand(computeEnvironment.verifyRuntime, { reportFailure: false });
  const [pathOpen, setPathOpen] = useState(false);
  const [pathDraft, setPathDraft] = useState("");
  const [selecting, setSelecting] = useState(false);
  const [selectionFailure, setSelectionFailure] = useState<string | null>(null);
  const selectionLock = useRef(false);
  const selectedInstallation = defaultComputeInstallation(language, preference, runtime.status);
  const managedInstallation = language.installations.find(
    (installation) => installation.source === "managed",
  );
  const disabled = Boolean(loading || refreshing || selecting || runtime.busy || !environmentId);
  const verificationKey = JSON.stringify([
    environmentId,
    refreshRevision,
    preference.enabled,
    preference.executable,
    runtime.status?.generationId,
    runtime.status?.selection,
    runtime.status?.operation?.operationId,
  ]);

  const select = async (executable: string | null) => {
    if (selectionLock.current || runtime.busy || loading || refreshing) return;
    selectionLock.current = true;
    setSelecting(true);
    setSelectionFailure(null);
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

  const test = async (executable: string) => {
    if (!environmentId) throw new Error("This server is unavailable.");
    const result = await verifyRuntime({
      environmentId,
      input: { cwd: null, languageId, executable },
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return result.value;
  };

  const helperOwner = runtime.status?.installationExecutable;
  const helperHasVisibleOwner =
    helperOwner &&
    language.installations.some((installation) => installation.executable === helperOwner);
  const helperNeedsRetarget =
    isMatlab &&
    runtime.status?.installed &&
    helperOwner &&
    helperOwner !== selectedInstallation?.executable;
  const hasExplicitSelection =
    Boolean(preference.executable.trim()) || (isPython && runtime.status?.selection === "managed");

  return (
    <section className="space-y-1.5" aria-labelledby={`${languageId}-heading`}>
      <div className="flex min-h-7 items-center justify-between gap-2 px-1">
        <h3
          id={`${languageId}-heading`}
          className="text-sm font-medium tracking-[-0.005em] text-foreground"
        >
          {language.descriptor.displayName}
        </h3>
        <Switch
          checked={preference.enabled}
          disabled={disabled}
          onCheckedChange={(enabled) => void onChange({ ...preference, enabled })}
          aria-label={`Enable ${language.descriptor.displayName}`}
        />
      </div>
      <div className="divide-y divide-border/50 rounded-xl border border-border/60 bg-card/40 shadow-xs/5">
        {loading ? (
          <p className="px-4 py-3 text-xs text-muted-foreground" role="status">
            Checking…
          </p>
        ) : null}
        {!loading && language.installations.length === 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <span className="text-sm text-muted-foreground">
              {preference.enabled ? "No installation detected" : "Disabled"}
            </span>
            {isMatlab && preference.enabled ? (
              <Button
                size="xs"
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
            ) : null}
          </div>
        ) : null}
        {language.installations.map((installation) => {
          const selected = installation.executable === selectedInstallation?.executable;
          const ownsManaged = isPython
            ? installation.source === "managed"
            : isMatlab &&
              runtime.status !== null &&
              (runtime.status.installed ? helperOwner === installation.executable : selected);
          return (
            <ComputeInstallationRow
              key={installation.executable}
              installation={installation}
              languageName={language.descriptor.displayName}
              selected={selected}
              enabled={preference.enabled}
              disabled={disabled}
              verificationKey={JSON.stringify([
                verificationKey,
                installation.executable,
                installation.version,
                installation.problem,
              ])}
              onTest={test}
              onUse={() => void select(installation.executable)}
              notice={
                ownsManaged && (runtime.failure || runtime.status?.operation) ? (
                  <ManagedRuntimeNotice runtime={runtime} />
                ) : undefined
              }
              recovery={
                selected && helperNeedsRetarget ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => void runtime.act("repair")}
                  >
                    Set up connection
                  </Button>
                ) : undefined
              }
            >
              {ownsManaged ? (
                <ManagedRuntimeActions
                  runtime={runtime}
                  connection={isMatlab}
                  canProvision={!isMatlab || selected}
                  disabled={selecting || refreshing || !environmentId}
                />
              ) : null}
            </ComputeInstallationRow>
          );
        })}
      </div>
      {!loading && isPython && !managedInstallation && runtime.status ? (
        <div className="px-1">
          {runtime.status.installed && preference.enabled ? (
            <p className="mb-1 text-xs text-warning">Scient-managed Python needs repair.</p>
          ) : null}
          <ManagedRuntimeNotice runtime={runtime} />
          <ManagedRuntimeActions
            runtime={runtime}
            disabled={selecting || refreshing || !environmentId}
          />
        </div>
      ) : null}
      {!loading && isMatlab && runtime.status?.installed && !helperHasVisibleOwner ? (
        <details className="px-1 text-xs text-muted-foreground">
          <summary className="w-fit cursor-pointer">Connection helper</summary>
          <div className="mt-2 space-y-1">
            <p>
              {helperOwner
                ? "The MATLAB installation used by this helper is no longer detected."
                : "The helper’s MATLAB installation could not be identified. Repair the connection for your selected installation."}
            </p>
            <ManagedRuntimeNotice runtime={runtime} />
            <ManagedRuntimeActions
              runtime={runtime}
              connection
              canProvision={selectedInstallation !== undefined}
              disabled={selecting || refreshing || !environmentId}
            />
          </div>
        </details>
      ) : null}
      {!loading ? (
        <div className="px-1">
          <div className="flex flex-wrap items-center gap-1">
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
              Use another installation…
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
          {pathOpen ? (
            <form
              className="mt-2 flex min-w-0 items-center gap-1.5"
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
            <p className="mt-1 text-xs text-destructive" role="alert">
              {selectionFailure}
            </p>
          ) : null}
        </div>
      ) : null}
      {language.failureMessage ? (
        <p className="px-1 text-xs text-destructive" role="alert">
          {language.failureMessage}
        </p>
      ) : null}
    </section>
  );
}

const PENDING_RUNTIME_DESCRIPTORS = [
  {
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  },
  {
    languageId: ComputeLanguageId.make("matlab"),
    displayName: "MATLAB",
    sourceExtensions: [".m"],
    capabilities: ["execute", "interrupt", "restart", "shutdown"],
  },
] as const;

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
  const [refreshRevision, setRefreshRevision] = useState(0);
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
    setRefreshRevision((revision) => revision + 1);
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
        variant="plain"
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
        <div className="space-y-5">
          {displayedLanguages.map((language) => {
            const preference = preferences.languages[language.descriptor.languageId] ?? {
              enabled: false,
              executable: language.configuredExecutable ?? "",
            };
            return (
              <LanguageSettingsRow
                key={language.descriptor.languageId}
                language={language}
                preference={preference}
                onChange={(next) => updateLanguage(language.descriptor.languageId, next)}
                environmentId={environmentId}
                loading={inventoryPending}
                refreshing={refreshing}
                refreshRevision={refreshRevision}
              />
            );
          })}
          {(refreshFailure ?? runtimes.error) ? (
            <p className="px-4 py-3 text-xs text-destructive" role="alert">
              {refreshFailure ?? runtimes.error}
            </p>
          ) : null}
          <div className="mx-auto w-full max-w-xl rounded-xl border border-dashed border-border/60 bg-muted/15 px-4 py-5 text-center">
            <p className="text-sm font-medium text-foreground/85">
              More scientific tools are coming soon
            </p>
            <p className="mt-1 text-xs text-muted-foreground/80">
              Additional languages and purpose-built scientific workflows are on the way.
            </p>
          </div>
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
