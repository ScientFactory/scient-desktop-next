import { RefreshCwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ComputeLanguageRuntimeInspection,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

import { usePrimarySettings, useUpdatePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironment } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { computeEnvironment } from "~/state/compute";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";

function readinessLabel(language: ComputeLanguageRuntimeInspection, enabled: boolean): string {
  if (!enabled) return "Disabled";
  if (language.runtimes.length === 0) return "No compatible runtime detected";
  const ready = language.runtimes.filter(
    (candidate) => candidate.verification.readiness === "ready",
  ).length;
  return ready > 0
    ? `${ready} ready runtime${ready === 1 ? "" : "s"}`
    : "Runtime requirements are missing";
}

function RuntimeDetails({
  language,
  enabled,
}: {
  language: ComputeLanguageRuntimeInspection;
  enabled: boolean;
}) {
  if (!enabled || language.runtimes.length === 0) return null;
  return (
    <div className="mt-3 space-y-1 border-t border-border/50 py-2">
      {language.runtimes.map(({ profile, verification }) => (
        <div
          key={`${profile.source}:${profile.executable}`}
          className="flex min-w-0 items-start justify-between gap-4 py-1.5 text-xs"
        >
          <div className="min-w-0">
            <div className="truncate font-medium text-foreground/90">{profile.displayName}</div>
            <div className="truncate font-mono text-muted-foreground">{profile.executable}</div>
            <div className="text-muted-foreground">
              {profile.source}
              {profile.architecture ? ` · ${profile.architecture}` : ""}
            </div>
          </div>
          <div
            className={
              verification.readiness === "ready"
                ? "shrink-0 text-success"
                : "max-w-64 shrink-0 text-right text-warning"
            }
          >
            {verification.readiness === "ready"
              ? "Ready"
              : verification.missingRequirements.length > 0
                ? `Missing: ${verification.missingRequirements.join(", ")}`
                : (verification.message ?? verification.readiness.replaceAll("-", " "))}
          </div>
        </div>
      ))}
    </div>
  );
}

function LanguageSettingsRow({
  language,
  preference,
  onChange,
  onRefresh,
  refreshing,
}: {
  language: ComputeLanguageRuntimeInspection;
  preference: ScientificComputingLanguageSettings;
  onChange: (next: ScientificComputingLanguageSettings) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [executable, setExecutable] = useState(preference.executable);
  useEffect(() => setExecutable(preference.executable), [preference.executable]);

  const persistExecutable = () => {
    const next = executable.trim();
    if (next !== preference.executable) onChange({ ...preference, executable: next });
  };

  return (
    <SettingsRow
      title={language.descriptor.displayName}
      description={`Enable ${language.descriptor.displayName} for new scientific sessions on this server.`}
      status={readinessLabel(language, preference.enabled)}
      control={
        <Switch
          checked={preference.enabled}
          onCheckedChange={(enabled) => onChange({ ...preference, enabled })}
          aria-label={`Enable ${language.descriptor.displayName}`}
        />
      }
    >
      <div className="mt-3 flex flex-col gap-2 border-t border-border/50 py-3 sm:flex-row sm:items-center">
        <Input
          nativeInput
          size="compact"
          value={executable}
          disabled={!preference.enabled}
          placeholder="Automatic"
          aria-label={`${language.descriptor.displayName} executable`}
          onChange={(event) => setExecutable(event.currentTarget.value)}
          onBlur={persistExecutable}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              persistExecutable();
              event.currentTarget.blur();
            }
          }}
        />
        <Button
          size="xs"
          variant="outline"
          disabled={!preference.enabled || refreshing}
          onClick={onRefresh}
        >
          <RefreshCwIcon className={refreshing ? "size-3 animate-spin" : "size-3"} />
          Refresh
        </Button>
      </div>
      {preference.enabled ? (
        <p className="text-[11px] text-muted-foreground">
          Capabilities: {language.descriptor.capabilities.join(", ")}
        </p>
      ) : null}
      <RuntimeDetails language={language} enabled={preference.enabled} />
    </SettingsRow>
  );
}

export function ScientificComputingSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const preferences = usePrimarySettings((settings) => settings.scientificComputing);
  const updateSettings = useUpdatePrimarySettings();
  const refreshRuntimes = useAtomCommand(computeEnvironment.refreshRuntimes);
  const [refreshing, setRefreshing] = useState(false);
  const runtimesAtom = primaryEnvironment
    ? computeEnvironment.runtimes({
        environmentId: primaryEnvironment.environmentId,
        input: { cwd: null, refresh: false },
      })
    : null;
  const runtimes = useEnvironmentQuery(runtimesAtom);

  const updateLanguage = (
    languageId: ComputeLanguageRuntimeInspection["descriptor"]["languageId"],
    next: ScientificComputingLanguageSettings,
  ) => {
    updateSettings({
      scientificComputing: {
        schemaVersion: 1,
        languages: { [languageId]: next },
      },
    });
  };

  const handleRefresh = async () => {
    if (!primaryEnvironment) return;
    setRefreshing(true);
    await refreshRuntimes({
      environmentId: primaryEnvironment.environmentId,
      input: { cwd: null, refresh: true },
    });
    setRefreshing(false);
    runtimes.refresh();
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="scientific-computing"
        title="Scientific Computing"
        headerAction={
          <span className="text-xs text-muted-foreground">
            {primaryEnvironment?.label ?? "No server selected"}
          </span>
        }
      >
        <SettingsRow
          {...searchableSetting("scientific-computing")}
          title="Optional runtimes"
          description="Choose only the languages you use. Scient discovers existing runtimes; it does not download packages, activate licenses, or change your environment. Executed code has this server environment's filesystem and network access and is not sandboxed."
          status={runtimes.error}
        />
        {(runtimes.data?.languages ?? []).map((language) => {
          const preference = preferences.languages[language.descriptor.languageId] ?? {
            enabled: false,
            executable: "",
          };
          return (
            <LanguageSettingsRow
              key={language.descriptor.languageId}
              language={language}
              preference={preference}
              onChange={(next) => updateLanguage(language.descriptor.languageId, next)}
              onRefresh={() => void handleRefresh()}
              refreshing={runtimes.isPending || refreshing}
            />
          );
        })}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
