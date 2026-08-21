import {
  ComputeCapability,
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeExecutionSource,
  computeOutputByteLength,
  ComputeLanguageId,
  ComputeOperationError,
  ComputeOutput,
  ComputeProjectId,
  ComputeRuntimeProfile,
  ComputeRuntimeVerification,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeSessionRecord,
  ComputeSessionStreamEvent,
  ComputeTransportKind,
  ComputeVariableSnapshot,
  ComputeExecutionOutputs,
  INITIAL_COMPUTE_SESSION_GENERATION,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
} from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

const ComputeCwd = Schema.String.check(Schema.isMaxLength(4096));
const ComputeExecutable = Schema.String.check(Schema.isMaxLength(4096));
const ComputeCode = Schema.String.check(Schema.isMaxLength(1024 * 1024));
const ComputeHistoryLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }));

export const ComputeLanguageDescriptor = Schema.Struct({
  languageId: ComputeLanguageId,
  displayName: Schema.String.check(Schema.isMaxLength(128)),
  sourceExtensions: Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(
    Schema.isMaxLength(32),
  ),
  capabilities: Schema.Array(ComputeCapability).check(Schema.isMaxLength(32)),
});
export type ComputeLanguageDescriptor = typeof ComputeLanguageDescriptor.Type;

export const ComputeRuntimeCandidate = Schema.Struct({
  profile: ComputeRuntimeProfile,
  verification: ComputeRuntimeVerification,
});
export type ComputeRuntimeCandidate = typeof ComputeRuntimeCandidate.Type;

export const ComputeLanguageRuntimeInspection = Schema.Struct({
  descriptor: ComputeLanguageDescriptor,
  enabled: Schema.Boolean,
  configuredExecutable: Schema.NullOr(ComputeExecutable),
  runtimes: Schema.Array(ComputeRuntimeCandidate).check(Schema.isMaxLength(64)),
});
export type ComputeLanguageRuntimeInspection = typeof ComputeLanguageRuntimeInspection.Type;

export const ComputeRuntimeInspection = Schema.Struct({
  contractVersion: Schema.Literal(1),
  scope: Schema.Literals(["environment", "project"]),
  languages: Schema.Array(ComputeLanguageRuntimeInspection).check(Schema.isMaxLength(32)),
});
export type ComputeRuntimeInspection = typeof ComputeRuntimeInspection.Type;

export class ComputeGatewayError extends Schema.TaggedErrorClass<ComputeGatewayError>()(
  "ComputeGatewayError",
  {
    operation: Schema.Literals([
      "inspect",
      "verify",
      "start",
      "list",
      "get",
      "submit",
      "cancel",
      "interrupt",
      "restart",
      "stop",
      "outputs",
      "variables",
      "subscribe",
    ]),
    reason: Schema.Literals([
      "project-not-initialized",
      "language-disabled",
      "language-unavailable",
      "runtime-not-found",
      "source-invalid",
      "settings-failed",
      "operation-failed",
    ]),
    message: Schema.NonEmptyString.check(Schema.isMaxLength(4096)),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const ComputeInspectRuntimesInput = Schema.Struct({
  cwd: Schema.NullOr(ComputeCwd),
  refresh: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ComputeInspectRuntimesInput = typeof ComputeInspectRuntimesInput.Type;

export const ComputeVerifyRuntimeInput = Schema.Struct({
  cwd: Schema.NullOr(ComputeCwd),
  languageId: ComputeLanguageId,
  executable: ComputeExecutable,
});
export type ComputeVerifyRuntimeInput = typeof ComputeVerifyRuntimeInput.Type;

export const ComputeStartProjectSessionInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  languageId: ComputeLanguageId,
  executable: Schema.NullOr(ComputeExecutable),
});
export type ComputeStartProjectSessionInput = typeof ComputeStartProjectSessionInput.Type;

export const ComputeProjectInput = Schema.Struct({ cwd: ComputeCwd });
export type ComputeProjectInput = typeof ComputeProjectInput.Type;

export const ComputeProjectSessionInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
});
export type ComputeProjectSessionInput = typeof ComputeProjectSessionInput.Type;

export const ComputeProjectSessionCommandInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeProjectSessionCommandInput = typeof ComputeProjectSessionCommandInput.Type;

export const ComputeSubmitProjectExecutionInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
  code: ComputeCode,
  source: ComputeExecutionSource,
});
export type ComputeSubmitProjectExecutionInput = typeof ComputeSubmitProjectExecutionInput.Type;

export const ComputeProjectExecutionCommandInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  executionId: ComputeExecutionId,
  expectedGeneration: ComputeSessionGeneration,
});
export type ComputeProjectExecutionCommandInput = typeof ComputeProjectExecutionCommandInput.Type;

export const ComputeListProjectExecutionsInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  limit: ComputeHistoryLimit.pipe(Schema.withDecodingDefault(Effect.succeed(100))),
});
export type ComputeListProjectExecutionsInput = typeof ComputeListProjectExecutionsInput.Type;

export const ComputeListProjectOutputsInput = Schema.Struct({
  cwd: ComputeCwd,
  sessionId: ComputeSessionId,
  executionId: Schema.NullOr(ComputeExecutionId),
});
export type ComputeListProjectOutputsInput = typeof ComputeListProjectOutputsInput.Type;

export const ComputeListProjectSessionsResult = Schema.Array(ComputeSessionRecord);
export const ComputeGetProjectSessionResult = Schema.NullOr(ComputeSessionRecord);
export const ComputeListProjectExecutionsResult = Schema.Array(ComputeExecutionRecord);

export {
  computeOutputByteLength,
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeExecutionOutputs,
  ComputeLanguageId,
  ComputeOperationError,
  ComputeOutput,
  ComputeProjectId,
  ComputeRuntimeVerification,
  ComputeSessionGeneration,
  ComputeSessionId,
  ComputeSessionRecord,
  ComputeSessionStreamEvent,
  ComputeTransportKind,
  ComputeVariableSnapshot,
  INITIAL_COMPUTE_SESSION_GENERATION,
  TERMINAL_COMPUTE_EXECUTION_STATUSES,
  TERMINAL_COMPUTE_SESSION_STATUSES,
};
