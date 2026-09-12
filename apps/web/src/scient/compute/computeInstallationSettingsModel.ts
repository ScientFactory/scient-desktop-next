import type {
  ComputeLanguageRuntimeInventory,
  ComputeManagedRuntimeStatus,
  ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

export type ComputeSettingsInstallation = ComputeLanguageRuntimeInventory["installations"][number];

export function runtimeSourceLabel(source: string): string {
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
