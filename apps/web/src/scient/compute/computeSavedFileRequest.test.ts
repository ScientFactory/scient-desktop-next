import {
  ComputeLanguageId,
  ComputeSessionGeneration,
  ComputeSessionId,
  EnvironmentId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { computeContextBindingForSurface, ComputeContextId } from "./computeContextStore";
import { computeSavedFileRequest } from "./computeSavedFileRequest";

const session = {
  sessionId: ComputeSessionId.make("owned"),
  generation: ComputeSessionGeneration.make(1),
  status: "ready" as const,
  languageId: ComputeLanguageId.make("python"),
  label: "Python",
};
const context = {
  ...computeContextBindingForSurface({
    contextId: ComputeContextId.make("standalone"),
    environmentId: EnvironmentId.make("env"),
    cwd: "/synthetic",
  }),
  lifecycle: "live" as const,
  sessionId: session.sessionId,
  generation: session.generation,
};
const file = {
  relativePath: "run.py",
  contents: "print('saved')\n",
  revision: "disk-revision",
  truncated: false,
  byteLength: 15,
};
const input = { context, session, file, relativePath: file.relativePath };

describe("standalone saved-file submission", () => {
  it("uses exactly the fresh saved bytes and revision in the existing document envelope", () => {
    expect(computeSavedFileRequest(input)).toMatchObject({
      code: file.contents,
      source: {
        _tag: "document",
        origin: "file",
        bufferState: "saved",
        path: file.relativePath,
        revision: file.revision,
      },
    });
  });
  it("supports MATLAB through the same path", () => {
    expect(
      computeSavedFileRequest({
        ...input,
        session: { ...session, languageId: ComputeLanguageId.make("matlab"), label: "MATLAB" },
        relativePath: "run.m",
        file: { ...file, relativePath: "run.m", contents: "plot(1:3);" },
      }).code,
    ).toBe("plot(1:3);");
  });
  it.each(["closing", "close-failed", "terminal", "starting"] as const)(
    "does not submit after ownership moves to %s during the read",
    (lifecycle) => {
      expect(() =>
        computeSavedFileRequest({ ...input, context: { ...context, lifecycle } }),
      ).toThrow("session changed");
    },
  );
  it("rejects a replaced generation/session and a removed context", () => {
    for (const changed of [
      null,
      { ...context, generation: ComputeSessionGeneration.make(2) },
      { ...context, sessionId: ComputeSessionId.make("other") },
    ]) {
      expect(() => computeSavedFileRequest({ ...input, context: changed })).toThrow(
        "session changed",
      );
    }
  });
  it("does not execute another language, partial file, wrong read response, or empty file", () => {
    expect(() => computeSavedFileRequest({ ...input, relativePath: "run.m" })).toThrow(
      "Python source",
    );
    expect(() => computeSavedFileRequest({ ...input, file: { ...file, truncated: true } })).toThrow(
      "complete saved file",
    );
    expect(() =>
      computeSavedFileRequest({ ...input, file: { ...file, relativePath: "other.py" } }),
    ).toThrow("complete saved file");
    expect(() =>
      computeSavedFileRequest({ ...input, file: { ...file, contents: "  \n" } }),
    ).toThrow("empty");
  });
});
