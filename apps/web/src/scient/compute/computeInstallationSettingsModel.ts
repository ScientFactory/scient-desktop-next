import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeStatus,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

export type ComputeSettingsInstallation = ComputeLanguageRuntimeInventory["installations"][number];

function runtimeSourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return "Scient-managed";
    case "configured":
      return "Custom installation";
    case "project":
      return "Project environment";
    case "path":
    case "conventional":
      return "System installation";
    default:
      return source;
  }
}

/** Short picker label. Never the executable path. */
export function computeRuntimePickerLabel(
  installation: ComputeSettingsInstallation,
  languageName: string,
): string {
  return `${installation.version ?? languageName} · ${runtimeSourceLabel(installation.source)}`;
}

export function defaultComputeInstallation(
  language: ComputeLanguageRuntimeInventory,
  preference: ScientificComputingLanguageSettings,
  managed: ComputeManagedRuntimeStatus | null,
): ComputeSettingsInstallation | undefined {
  if (language.descriptor.languageId === "python" && managed?.selection === "managed") {
    return language.installations.find((installation) => installation.source === "managed");
  }
  const configured = preference.executable.trim();
  if (configured) {
    return language.installations.find(
      (installation) =>
        installation.executable === configured ||
        (language.configuredExecutable === configured && installation.configured === true),
    );
  }
  // A settings save can arrive before the refreshed inventory. Its old explicit
  // candidate order must not be presented as the new automatic default.
  if (language.configuredExecutable?.trim()) return undefined;
  return language.installations.find((installation) => installation.source !== "managed");
}

export type ComputeCurrentRuntimeSummary = {
  readonly kind: "ready" | "setup" | "connect" | "repair" | "missing";
  readonly title: string;
  readonly detail: string;
};

/** One-line current runtime for the default Settings chrome. */
export function computeCurrentRuntimeSummary(input: {
  readonly language: ComputeLanguageRuntimeInventory;
  readonly preference: ScientificComputingLanguageSettings;
  readonly managed: ComputeManagedRuntimeStatus | null;
}): ComputeCurrentRuntimeSummary {
  const { language, preference, managed } = input;
  const isMatlab = language.descriptor.languageId === "matlab";
  const selected = defaultComputeInstallation(language, preference, managed);
  const source = selected === undefined ? null : runtimeSourceLabel(selected.source);
  const enabled =
    preference.enabled ||
    (language.descriptor.languageId === "python" &&
      managed?.installed === true &&
      managed.selection === "managed");

  if (selected?.problem) {
    return {
      kind: "repair",
      title: selected.problem,
      detail: source ?? language.descriptor.displayName,
    };
  }
  if (selected !== undefined && enabled) {
    return {
      kind: "ready",
      title: selected.version ?? language.descriptor.displayName,
      detail: source ?? "Ready",
    };
  }
  if (isMatlab) {
    // Inventory listing is skipped while MATLAB is disabled, so an empty list
    // is not proof that MATLAB is missing on the machine.
    if (!enabled) {
      return {
        kind: "connect",
        title: "Not connected",
        detail: "Connect the MATLAB already installed on this server.",
      };
    }
    if (language.installations.length === 0) {
      return {
        kind: "missing",
        title: "Not connected",
        detail: "Requires a licensed MATLAB installation on this server.",
      };
    }
    return {
      kind: "connect",
      title: "Not connected",
      detail: "Connect the MATLAB already installed on this server.",
    };
  }
  return {
    kind: "setup",
    title: "Not set up",
    detail: "Set up Scientific Python here, or choose an existing runtime under Change runtime.",
  };
}

/** Save the requested path before releasing managed precedence. A failed save
 * must leave the current default intact; a failed release is surfaced for retry. */
export async function selectExistingComputeInstallation(input: {
  executable: string;
  preference: ScientificComputingLanguageSettings;
  releaseManaged: boolean;
  save: (preference: ScientificComputingLanguageSettings) => Promise<boolean>;
  useExisting: () => Promise<void>;
}): Promise<void> {
  const saved = await input.save({ ...input.preference, executable: input.executable.trim() });
  if (!saved) throw new Error("The installation could not be selected. Settings were not saved.");
  if (input.releaseManaged) await input.useExisting();
}
