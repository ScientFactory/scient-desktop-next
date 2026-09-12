import type { ComputeSessionRecord, ProjectReadFileResult } from "@t3tools/contracts";

import { ownsLiveComputeSession, type ComputeContextBinding } from "./computeContextStore";
import { computeSourceLanguageForPath } from "./computeSourceLanguage";
import { computeFile } from "./computeSourceSlices";

/** Validate after the fresh read: closing/restarting during I/O must not retarget a run. */
export function computeSavedFileRequest(input: {
  readonly context: ComputeContextBinding | null;
  readonly session: Pick<
    ComputeSessionRecord,
    "sessionId" | "generation" | "status" | "languageId" | "label"
  >;
  readonly relativePath: string;
  readonly file: ProjectReadFileResult;
}) {
  if (!ownsLiveComputeSession(input.context, input.session) || input.session.status !== "ready") {
    throw new Error("This compute session changed. Choose the file again when it is ready.");
  }
  const language = computeSourceLanguageForPath(input.relativePath);
  if (language?.languageId !== input.session.languageId) {
    throw new Error(`Choose a ${input.session.label} source file for this session.`);
  }
  if (input.file.relativePath !== input.relativePath || input.file.truncated) {
    throw new Error("The complete saved file could not be read. Open a smaller source file.");
  }
  const slice = computeFile(input.file.contents);
  if (slice === null) throw new Error("This saved file is empty.");
  return {
    code: slice.code,
    source: {
      _tag: "document" as const,
      origin: "file" as const,
      path: input.relativePath,
      bufferState: "saved" as const,
      revision: input.file.revision,
      range: slice.range,
    },
  };
}
