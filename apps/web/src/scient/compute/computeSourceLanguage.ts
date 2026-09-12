import { ComputeLanguageId } from "@t3tools/contracts";

export interface ComputeSourceLanguage {
  readonly languageId: ComputeLanguageId;
  readonly displayName: string;
  readonly extensions: ReadonlyArray<`.${string}`>;
  readonly cellMarker: RegExp;
}

export const PYTHON_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("python"),
  displayName: "Python",
  extensions: [".py"],
  cellMarker: /^\s*#\s*%%(?:\s|$)/,
};

export const MATLAB_COMPUTE_SOURCE: ComputeSourceLanguage = {
  languageId: ComputeLanguageId.make("matlab"),
  displayName: "MATLAB",
  extensions: [".m"],
  cellMarker: /^\s*%%(?:\s|$)/,
};

const COMPUTE_SOURCES = [PYTHON_COMPUTE_SOURCE, MATLAB_COMPUTE_SOURCE] as const;

export function computeSourceLanguageForPath(path: string): ComputeSourceLanguage | null {
  const normalized = path.toLowerCase();
  return (
    COMPUTE_SOURCES.find((source) =>
      source.extensions.some((extension) => normalized.endsWith(extension)),
    ) ?? null
  );
}
