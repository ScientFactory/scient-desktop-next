// @effect-diagnostics nodeBuiltinImport:off -- environment inspection needs a stable host cwd.
import * as NodeOS from "node:os";

import { inspectScientProject, readScientProjectIdentity } from "@scientfactory/project-init";
import {
  ComputeProjectId,
  type ComputeLanguageId,
  type ComputeSourceRange,
} from "@scientfactory/compute";
import {
  ComputeGatewayError,
  type ComputeInspectRuntimesInput,
  type ComputeListProjectExecutionsInput,
  type ComputeListProjectOutputsInput,
  type ComputeProjectExecutionCommandInput,
  type ComputeProjectInput,
  type ComputeProjectSessionCommandInput,
  type ComputeProjectSessionInput,
  type ComputeStartProjectSessionInput,
  type ComputeSubmitProjectExecutionInput,
  type ComputeVerifyRuntimeInput,
  DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS,
  type ServerSettings as ServerSettingsValue,
  type ScientificComputingLanguageSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ServerSettings from "../../serverSettings.ts";
import type * as WorkspaceFileSystem from "../../workspace/WorkspaceFileSystem.ts";
import type { ComputeSessionService } from "./ComputeSessionService.ts";

type ComputeGatewayService = Pick<
  ComputeSessionService["Service"],
  | "runtimeDescriptors"
  | "inspectRuntimes"
  | "verifyRuntime"
  | "startSession"
  | "listSessions"
  | "getSession"
  | "listExecutions"
  | "listOutputs"
  | "submitExecution"
  | "cancelExecution"
  | "interruptSession"
  | "restartSession"
  | "stopSession"
  | "inspectVariables"
  | "subscribeSessions"
>;
type ComputeGatewaySettings = Pick<ServerSettings.ServerSettingsService["Service"], "getSettings">;
type ComputeGatewayWorkspace = Pick<WorkspaceFileSystem.WorkspaceFileSystem["Service"], "readFile">;

type GatewayOperation = ComputeGatewayError["operation"];
type GatewayReason = ComputeGatewayError["reason"];

function gatewayError(
  operation: GatewayOperation,
  reason: GatewayReason,
  message: string,
  cause?: unknown,
): ComputeGatewayError {
  return new ComputeGatewayError({
    operation,
    reason,
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function languageSettings(
  settings: Pick<ServerSettingsValue, "scientificComputing">,
  languageId: ComputeLanguageId,
): ScientificComputingLanguageSettings {
  return (
    settings.scientificComputing.languages[languageId] ??
    DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS
  );
}

export function makeComputeRpcGateway(input: {
  readonly compute: ComputeGatewayService;
  readonly serverSettings: ComputeGatewaySettings;
  readonly workspaceFileSystem: ComputeGatewayWorkspace;
}) {
  const readSettings = (operation: GatewayOperation) =>
    input.serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        gatewayError(
          operation,
          "settings-failed",
          "Unable to read scientific computing settings.",
          cause,
        ),
      ),
    );

  const projectFor = Effect.fn("ComputeRpcGateway.projectFor")(function* (
    operation: GatewayOperation,
    cwd: string,
  ) {
    const project = yield* Effect.tryPromise({
      try: async () => {
        const inspection = await inspectScientProject(cwd);
        if (inspection.state !== "initialized") return null;
        const identity = await readScientProjectIdentity(inspection.root);
        return { root: inspection.root, projectId: ComputeProjectId.make(identity.projectId) };
      },
      catch: (cause) =>
        gatewayError(
          operation,
          "operation-failed",
          "Unable to inspect the Scient project identity.",
          cause,
        ),
    });
    if (project !== null) return project;
    return yield* gatewayError(
      operation,
      "project-not-initialized",
      "Initialize this folder as a Scient project before starting a compute session.",
    );
  });

  const requireEnabledLanguage = Effect.fn("ComputeRpcGateway.requireEnabledLanguage")(function* (
    operation: GatewayOperation,
    languageId: ComputeLanguageId,
  ) {
    const descriptor = input.compute.runtimeDescriptors.find(
      (candidate) => candidate.languageId === languageId,
    );
    if (descriptor === undefined) {
      return yield* gatewayError(
        operation,
        "language-unavailable",
        `This Scient build does not provide the '${languageId}' compute adapter.`,
      );
    }
    const settings = yield* readSettings(operation);
    const preference = languageSettings(settings, languageId);
    if (!preference.enabled) {
      return yield* gatewayError(
        operation,
        "language-disabled",
        `${descriptor.displayName} is disabled in Scientific Computing settings.`,
      );
    }
    return { descriptor, preference };
  });

  const inspectRuntimes = Effect.fn("ComputeRpcGateway.inspectRuntimes")(function* (
    request: ComputeInspectRuntimesInput,
  ) {
    const settings = yield* readSettings("inspect");
    const project = request.cwd === null ? null : yield* projectFor("inspect", request.cwd);
    const preferences = Object.fromEntries(
      input.compute.runtimeDescriptors.map((descriptor) => [
        descriptor.languageId,
        languageSettings(settings, descriptor.languageId),
      ]),
    );
    const inspected = yield* input.compute.inspectRuntimes({
      projectRoot: project?.root ?? null,
      workingDirectory: project?.root ?? NodeOS.tmpdir(),
      configuredExecutables: Object.fromEntries(
        Object.entries(preferences).map(([languageId, preference]) => [
          languageId,
          preference.executable.length === 0 ? null : preference.executable,
        ]),
      ),
      enabledLanguageIds: new Set(
        Object.entries(preferences).flatMap(([languageId, preference]) =>
          preference.enabled ? [languageId] : [],
        ),
      ),
      refresh: request.refresh,
    });
    return {
      contractVersion: 1 as const,
      scope: project === null ? ("environment" as const) : ("project" as const),
      languages: inspected.map((language) => ({
        ...language,
        enabled: preferences[language.descriptor.languageId]?.enabled ?? false,
        configuredExecutable: preferences[language.descriptor.languageId]?.executable || null,
      })),
    };
  });

  const verifyRuntime = Effect.fn("ComputeRpcGateway.verifyRuntime")(function* (
    request: ComputeVerifyRuntimeInput,
  ) {
    yield* requireEnabledLanguage("verify", request.languageId);
    const project = request.cwd === null ? null : yield* projectFor("verify", request.cwd);
    const executable = request.executable.trim();
    if (executable.length === 0) {
      return yield* gatewayError(
        "verify",
        "runtime-not-found",
        "Choose a detected runtime or enter an executable path to verify.",
      );
    }
    return yield* input.compute.verifyRuntime({
      languageId: request.languageId,
      executable,
      workingDirectory: project?.root ?? NodeOS.tmpdir(),
      refresh: true,
    });
  });

  const startSession = Effect.fn("ComputeRpcGateway.startSession")(function* (
    request: ComputeStartProjectSessionInput,
  ) {
    const project = yield* projectFor("start", request.cwd);
    const { descriptor, preference } = yield* requireEnabledLanguage("start", request.languageId);
    return yield* input.compute.startSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
      languageId: request.languageId,
      label: descriptor.displayName,
      workingDirectory: project.root,
      configuredExecutable:
        request.executable ?? (preference.executable.length === 0 ? null : preference.executable),
    });
  });

  const listSessions = Effect.fn("ComputeRpcGateway.listSessions")(function* (
    request: ComputeProjectInput,
  ) {
    const project = yield* projectFor("list", request.cwd);
    const sessions = yield* input.compute.listSessions({ projectId: project.projectId });
    return sessions.slice(-100).toReversed();
  });

  const getSession = Effect.fn("ComputeRpcGateway.getSession")(function* (
    request: ComputeProjectSessionInput,
  ) {
    const project = yield* projectFor("get", request.cwd);
    return yield* input.compute.getSession({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
  });

  const listExecutions = Effect.fn("ComputeRpcGateway.listExecutions")(function* (
    request: ComputeListProjectExecutionsInput,
  ) {
    const project = yield* projectFor("list", request.cwd);
    const executions = yield* input.compute.listExecutions({
      projectId: project.projectId,
      sessionId: request.sessionId,
    });
    return executions.slice(-request.limit);
  });

  const listOutputs = Effect.fn("ComputeRpcGateway.listOutputs")(function* (
    request: ComputeListProjectOutputsInput,
  ) {
    const project = yield* projectFor("outputs", request.cwd);
    return yield* input.compute.listOutputs({
      projectId: project.projectId,
      sessionId: request.sessionId,
      executionId: request.executionId,
    });
  });

  const submitExecution = Effect.fn("ComputeRpcGateway.submitExecution")(function* (
    request: ComputeSubmitProjectExecutionInput,
  ) {
    const project = yield* projectFor("submit", request.cwd);
    const source = request.source;
    if (source._tag === "document") {
      const file = yield* input.workspaceFileSystem
        .readFile({ cwd: project.root, relativePath: source.path })
        .pipe(
          Effect.mapError((cause) =>
            gatewayError(
              "submit",
              "source-invalid",
              `Unable to resolve compute source '${source.path}' inside this project.`,
              cause,
            ),
          ),
        );
      if (source.bufferState === "saved") {
        if (source.revision === null || file.revision !== source.revision) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The saved source changed before execution. Submit the current buffer as dirty or try again after it is saved.",
          );
        }
        if (file.truncated) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The saved source is too large to validate for execution.",
          );
        }
        const submittedSource = extractComputeSourceRange(file.contents, source.range);
        if (submittedSource === null || submittedSource !== request.code) {
          return yield* gatewayError(
            "submit",
            "source-invalid",
            "The submitted code does not match the claimed saved source range.",
          );
        }
      }
    }
    return yield* input.compute.submitExecution({
      ...request,
      projectId: project.projectId,
    });
  });

  const cancelExecution = Effect.fn("ComputeRpcGateway.cancelExecution")(function* (
    request: ComputeProjectExecutionCommandInput,
  ) {
    const project = yield* projectFor("cancel", request.cwd);
    return yield* input.compute.cancelExecution({ ...request, projectId: project.projectId });
  });

  const sessionCommand = (
    operation: "interrupt" | "restart" | "stop",
    command: ComputeGatewayService["interruptSession"],
  ) =>
    Effect.fn(`ComputeRpcGateway.${operation}`)(function* (
      request: ComputeProjectSessionCommandInput,
    ) {
      const project = yield* projectFor(operation, request.cwd);
      return yield* command({ ...request, projectId: project.projectId });
    });

  const subscribeSessions = Effect.fn("ComputeRpcGateway.subscribeSessions")(function* (
    request: ComputeProjectInput,
  ) {
    const project = yield* projectFor("subscribe", request.cwd);
    return yield* input.compute.subscribeSessions({ projectId: project.projectId });
  });

  const inspectVariables = Effect.fn("ComputeRpcGateway.inspectVariables")(function* (
    request: ComputeProjectSessionCommandInput,
  ) {
    const project = yield* projectFor("variables", request.cwd);
    return yield* input.compute.inspectVariables({ ...request, projectId: project.projectId });
  });

  return {
    inspectRuntimes,
    verifyRuntime,
    startSession,
    listSessions,
    getSession,
    listExecutions,
    listOutputs,
    submitExecution,
    cancelExecution,
    interruptSession: sessionCommand("interrupt", input.compute.interruptSession),
    restartSession: sessionCommand("restart", input.compute.restartSession),
    stopSession: sessionCommand("stop", input.compute.stopSession),
    inspectVariables,
    subscribeSessions,
  };
}

/** Exact UTF-16 editor range extraction; line indices are zero-based and end-exclusive by column. */
export function extractComputeSourceRange(
  contents: string,
  range: ComputeSourceRange | null,
): string | null {
  if (range === null) return contents;
  const lineStarts = [0];
  for (let index = 0; index < contents.length; index += 1) {
    if (contents[index] === "\n") lineStarts.push(index + 1);
  }
  const lineEnd = (line: number): number | null => {
    const start = lineStarts[line];
    if (start === undefined) return null;
    const newline = contents.indexOf("\n", start);
    const rawEnd = newline === -1 ? contents.length : newline;
    return rawEnd > start && contents[rawEnd - 1] === "\r" ? rawEnd - 1 : rawEnd;
  };
  const start = lineStarts[range.startLine];
  const end = lineStarts[range.endLine];
  const startLineEnd = lineEnd(range.startLine);
  const endLineEnd = lineEnd(range.endLine);
  if (start === undefined || end === undefined || startLineEnd === null || endLineEnd === null) {
    return null;
  }
  if (
    range.startColumn > startLineEnd - start ||
    range.endColumn > endLineEnd - end ||
    range.endLine < range.startLine ||
    (range.endLine === range.startLine && range.endColumn < range.startColumn)
  ) {
    return null;
  }
  return contents.slice(start + range.startColumn, end + range.endColumn);
}

export type ComputeRpcGateway = ReturnType<typeof makeComputeRpcGateway>;
