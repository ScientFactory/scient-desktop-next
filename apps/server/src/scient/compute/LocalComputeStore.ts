// @effect-diagnostics nodeBuiltinImport:off -- append-only session journals are a Node filesystem boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import {
  ComputeExecutionId,
  ComputeExecutionRequestRecord,
  ComputeExecutionResultRecord,
  ComputeOutput,
  ComputeProjectId,
  ComputeSessionId,
  ComputeSessionJournalEntry,
  ComputeSessionRecord,
  type ComputeExecutionRecord,
  type ComputeImageMediaType,
  type ComputeOutputResourceRef,
  type ComputeSessionStorage,
} from "@scientfactory/compute";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import * as ServerConfig from "../../config.ts";

/**
 * The filesystem as the authority on what a compute session did.
 *
 * A session is a live conversation with a process that can die, and a process
 * that dies takes its memory with it. This module is what remains: it knows
 * nothing about kernels, queues, or generations, and answers only what was
 * submitted, what came back, and how it ended.
 *
 * Layout, under `<stateDir>/compute/sessions/<projectId>/<sessionId>/`:
 *
 *     session.json                     the session record, atomically replaced
 *     journal.ndjson                   what happened, in order, append-only
 *     output.ndjson                    output belonging to no execution
 *     outputs/<hex>.<ext>              image bytes, content-addressed
 *     executions/<executionId>/
 *         request.json                 written once, never rewritten
 *         result.json                  atomically replaced as it progresses
 *         output.ndjson                this execution's output, append-only
 *         outputs/<hex>.<ext>          its image bytes, content-addressed
 *
 * Splitting a request from its result is what makes recovery honest rather than
 * a guess: a request with no result is an execution that was in flight when the
 * server stopped, and nothing else produces that shape.
 */

const SessionJson = Schema.fromJsonString(ComputeSessionRecord);
const RequestJson = Schema.fromJsonString(ComputeExecutionRequestRecord);
const ResultJson = Schema.fromJsonString(ComputeExecutionResultRecord);
const OutputJson = Schema.fromJsonString(ComputeOutput);
const JournalJson = Schema.fromJsonString(ComputeSessionJournalEntry);

const decodeSession = Schema.decodeUnknownOption(SessionJson);
const encodeSession = Schema.encodeEffect(SessionJson);
const decodeRequest = Schema.decodeUnknownOption(RequestJson);
const encodeRequest = Schema.encodeEffect(RequestJson);
const decodeResult = Schema.decodeUnknownOption(ResultJson);
const encodeResult = Schema.encodeEffect(ResultJson);
const decodeOutput = Schema.decodeUnknownOption(OutputJson);
const encodeOutput = Schema.encodeEffect(OutputJson);
const decodeJournalEntry = Schema.decodeUnknownOption(JournalJson);
const encodeJournalEntry = Schema.encodeEffect(JournalJson);

/**
 * The largest image one output may store.
 *
 * A figure is a few hundred kilobytes; anything approaching this is a runtime
 * misbehaving or a user rendering a raster of an entire dataset. Refusing is
 * better than filling a disk, and the refusal is recorded as a system output so
 * the transcript says the figure was dropped rather than silently omitting it.
 */
export const MAXIMUM_COMPUTE_OUTPUT_IMAGE_BYTES = 32 * 1024 * 1024;

const CONTENT_HASH_PATTERN = /^sha256:([0-9a-f]{64})$/u;

/**
 * Rejects anything that is not a single, ordinary path segment.
 *
 * `ComputeSessionId` and `ComputeExecutionId` are bounded non-empty strings and
 * nothing more, so nothing in the type stops `../../etc`. Both are used as
 * directory names, and a session identifier may be chosen by a caller for
 * idempotency, so this is checked here rather than assumed of callers.
 */
const SAFE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isSafeSegment(value: string): boolean {
  // The leading-character class already excludes "." and "..", and the class
  // excludes separators, NUL, and control characters. Stated as an allow list
  // because a deny list of dangerous characters is a list someone has to keep
  // complete.
  return SAFE_SEGMENT_PATTERN.test(value);
}

export interface ResolvedComputeOutputImage {
  readonly path: string;
  readonly fileName: string;
  readonly mediaType: ComputeImageMediaType;
  readonly contentHash: string;
  readonly byteLength: number;
  readonly revision: { readonly size: number; readonly mtimeMs: number | null };
}

export interface LoadedComputeOutputs {
  readonly outputs: ReadonlyArray<ComputeOutput>;
  /**
   * How many lines could not be read.
   *
   * Reported rather than thrown: one torn line at the end of an append-only
   * file is what a crash looks like, and it must not make the rest of a
   * transcript unreadable.
   */
  readonly corruptLineCount: number;
}

export class LocalComputeStoreError extends Schema.TaggedErrorClass<LocalComputeStoreError>()(
  "LocalComputeStoreError",
  {
    operation: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export class LocalComputeStore extends Context.Service<
  LocalComputeStore,
  {
    readonly writeSession: (
      record: ComputeSessionRecord,
    ) => Effect.Effect<void, LocalComputeStoreError>;
    readonly appendJournal: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
      entry: ComputeSessionJournalEntry,
    ) => Effect.Effect<void, LocalComputeStoreError>;
    readonly writeExecutionRequest: (
      projectId: ComputeProjectId,
      request: ComputeExecutionRequestRecord,
    ) => Effect.Effect<void, LocalComputeStoreError>;
    readonly writeExecutionResult: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
      result: ComputeExecutionResultRecord,
    ) => Effect.Effect<void, LocalComputeStoreError>;
    readonly appendOutputs: (input: {
      readonly projectId: ComputeProjectId;
      readonly sessionId: ComputeSessionId;
      readonly executionId: ComputeExecutionId | null;
      readonly outputs: ReadonlyArray<ComputeOutput>;
    }) => Effect.Effect<void, LocalComputeStoreError>;
    readonly writeOutputImage: (input: {
      readonly projectId: ComputeProjectId;
      readonly sessionId: ComputeSessionId;
      readonly executionId: ComputeExecutionId | null;
      readonly contentHash: string;
      readonly mediaType: ComputeImageMediaType;
      readonly bytes: Uint8Array;
    }) => Effect.Effect<{ readonly fileName: string }, LocalComputeStoreError>;
    readonly loadProjectIds: () => Effect.Effect<
      ReadonlyArray<ComputeProjectId>,
      LocalComputeStoreError
    >;
    readonly loadSessions: (
      projectId: ComputeProjectId,
    ) => Effect.Effect<ReadonlyArray<ComputeSessionRecord>, LocalComputeStoreError>;
    readonly loadSession: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
    ) => Effect.Effect<ComputeSessionRecord | null, LocalComputeStoreError>;
    readonly loadExecutions: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
    ) => Effect.Effect<ReadonlyArray<ComputeExecutionRecord>, LocalComputeStoreError>;
    readonly loadExecution: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
      executionId: ComputeExecutionId,
    ) => Effect.Effect<ComputeExecutionRecord | null, LocalComputeStoreError>;
    readonly loadOutputs: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
      executionId: ComputeExecutionId | null,
    ) => Effect.Effect<LoadedComputeOutputs, LocalComputeStoreError>;
    readonly loadJournal: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
    ) => Effect.Effect<ReadonlyArray<ComputeSessionJournalEntry>, LocalComputeStoreError>;
    readonly resolveOutputImage: (
      ref: ComputeOutputResourceRef,
    ) => Effect.Effect<ResolvedComputeOutputImage | null, LocalComputeStoreError>;
    readonly measureSessionStorage: (
      projectId: ComputeProjectId,
      sessionId: ComputeSessionId,
    ) => Effect.Effect<ComputeSessionStorage, LocalComputeStoreError>;
    readonly removeDisposableSessionData: (
      record: ComputeSessionRecord,
      removedAt: string,
    ) => Effect.Effect<ComputeSessionRecord, LocalComputeStoreError>;
  }
>()("t3/scient/compute/LocalComputeStore") {}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  return `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  const handle = await NodeFSP.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return `sha256:${hash.digest("hex")}`;
}

function imageFileExtension(mediaType: ComputeImageMediaType): ".png" | ".svg" {
  return mediaType === "image/png" ? ".png" : ".svg";
}

async function directoryByteLength(directory: string): Promise<number> {
  let total = 0;
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(directory);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
  for (const entry of entries) {
    const info = await NodeFSP.lstat(`${directory}/${entry}`);
    if (info.isFile()) total += info.size;
  }
  return total;
}

async function fileByteLength(filePath: string): Promise<number> {
  try {
    const info = await NodeFSP.lstat(filePath);
    return info.isFile() ? info.size : 0;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw cause;
  }
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // One writer at a time. Every mutation here is either an atomic replace or an
  // append, and both are safe against a reader; what they are not safe against
  // is another writer appending between this one's encode and its write.
  const writeLock = yield* Semaphore.make(1);
  const sessionsRoot = path.join(config.computeDir, "sessions");

  const storeError = (operation: string, operationPath: string, cause: unknown) =>
    new LocalComputeStoreError({ operation, path: operationPath, cause });

  const mapStoreError =
    (operation: string, operationPath: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, LocalComputeStoreError, R> =>
      Effect.mapError(effect, (cause) => storeError(operation, operationPath, cause));

  const atomicWrite = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      mapStoreError("atomic-write", filePath),
    );

  /** Joins only after every segment has been proved to be one. */
  const joinSegments = (
    operation: string,
    ...segments: ReadonlyArray<string>
  ): Effect.Effect<string, LocalComputeStoreError> => {
    for (const segment of segments) {
      if (!isSafeSegment(segment)) {
        return Effect.fail(
          storeError(
            operation,
            sessionsRoot,
            new Error(`'${segment}' is not usable as a storage path segment.`),
          ),
        );
      }
    }
    return Effect.succeed(path.join(sessionsRoot, ...segments));
  };

  const sessionDirectory = (projectId: ComputeProjectId, sessionId: ComputeSessionId) =>
    joinSegments("session-directory", projectId, sessionId);

  const executionDirectory = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId,
  ) => joinSegments("execution-directory", projectId, sessionId, "executions", executionId);

  /**
   * Where one execution's data lives, or the session's own when there is no
   * execution. Output that belongs to no command is stored against the session,
   * because attributing a stray thread's print to whichever cell happens to be
   * running would put one execution's output inside another's transcript.
   */
  const outputOwnerDirectory = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId | null,
  ) =>
    executionId === null
      ? sessionDirectory(projectId, sessionId)
      : executionDirectory(projectId, sessionId, executionId);

  const appendLine = (filePath: string, operation: string, line: string) =>
    Effect.gen(function* () {
      yield* fs
        .makeDirectory(path.dirname(filePath), { recursive: true })
        .pipe(mapStoreError(`${operation}-directory`, filePath));
      yield* Effect.tryPromise({
        try: () => NodeFSP.appendFile(filePath, `${line}\n`, "utf8"),
        catch: (cause) => storeError(operation, filePath, cause),
      });
    });

  const readLines = (filePath: string, operation: string) =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(filePath).pipe(mapStoreError("exists", filePath)))) return [];
      const contents = yield* fs.readFileString(filePath).pipe(mapStoreError(operation, filePath));
      return contents.split("\n").filter((line) => line.length > 0);
    });

  const writeSession = (record: ComputeSessionRecord) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* sessionDirectory(record.projectId, record.sessionId);
        const filePath = path.join(directory, "session.json");
        const contents = yield* encodeSession(record).pipe(
          mapStoreError("encode-session", filePath),
        );
        yield* atomicWrite(filePath, contents);
      }),
    );

  /** Appends without taking the write lease, for a caller that already holds it. */
  const appendJournalEntry = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    entry: ComputeSessionJournalEntry,
  ) =>
    Effect.gen(function* () {
      const directory = yield* sessionDirectory(projectId, sessionId);
      const filePath = path.join(directory, "journal.ndjson");
      const line = yield* encodeJournalEntry(entry).pipe(
        mapStoreError("encode-journal-entry", filePath),
      );
      yield* appendLine(filePath, "append-journal", line);
    });

  const appendJournal = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    entry: ComputeSessionJournalEntry,
  ) => writeLock.withPermits(1)(appendJournalEntry(projectId, sessionId, entry));

  const writeExecutionRequest = (
    projectId: ComputeProjectId,
    request: ComputeExecutionRequestRecord,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* executionDirectory(
          projectId,
          request.sessionId,
          request.executionId,
        );
        const filePath = path.join(directory, "request.json");
        if (yield* fs.exists(filePath).pipe(mapStoreError("exists", filePath))) {
          return yield* storeError(
            "write-execution-request",
            filePath,
            new Error("A compute execution request is immutable once written."),
          );
        }
        const contents = yield* encodeRequest(request).pipe(
          mapStoreError("encode-execution-request", filePath),
        );
        yield* atomicWrite(filePath, contents);
      }),
    );

  const writeExecutionResult = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    result: ComputeExecutionResultRecord,
  ) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* executionDirectory(projectId, sessionId, result.executionId);
        const filePath = path.join(directory, "result.json");
        const contents = yield* encodeResult(result).pipe(
          mapStoreError("encode-execution-result", filePath),
        );
        yield* atomicWrite(filePath, contents);
      }),
    );

  const appendOutputs = (input: {
    readonly projectId: ComputeProjectId;
    readonly sessionId: ComputeSessionId;
    readonly executionId: ComputeExecutionId | null;
    readonly outputs: ReadonlyArray<ComputeOutput>;
  }) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        if (input.outputs.length === 0) return;
        const directory = yield* outputOwnerDirectory(
          input.projectId,
          input.sessionId,
          input.executionId,
        );
        const filePath = path.join(directory, "output.ndjson");
        const lines: string[] = [];
        for (const output of input.outputs) {
          lines.push(yield* encodeOutput(output).pipe(mapStoreError("encode-output", filePath)));
        }
        // One append for a batch: a partial write can tear the last line, and a
        // torn line is recoverable, but a batch written line by line can be
        // interleaved with another writer's batch and reorder a transcript.
        yield* appendLine(filePath, "append-output", lines.join("\n"));
      }),
    );

  const writeOutputImage = (input: {
    readonly projectId: ComputeProjectId;
    readonly sessionId: ComputeSessionId;
    readonly executionId: ComputeExecutionId | null;
    readonly contentHash: string;
    readonly mediaType: ComputeImageMediaType;
    readonly bytes: Uint8Array;
  }) =>
    Effect.gen(function* () {
      const owner = yield* outputOwnerDirectory(
        input.projectId,
        input.sessionId,
        input.executionId,
      );
      const digest = CONTENT_HASH_PATTERN.exec(input.contentHash);
      if (digest?.[1] === undefined) {
        return yield* storeError(
          "write-output-image",
          owner,
          new Error("An image content hash must be a sha256 digest."),
        );
      }
      if (input.bytes.byteLength > MAXIMUM_COMPUTE_OUTPUT_IMAGE_BYTES) {
        return yield* storeError(
          "write-output-image",
          owner,
          new Error(
            `An image of ${input.bytes.byteLength} bytes exceeds the ${MAXIMUM_COMPUTE_OUTPUT_IMAGE_BYTES}-byte limit.`,
          ),
        );
      }
      // Verified on the way in, not only on the way out. A file whose name
      // disagreed with its bytes would be permanently unresolvable, and the
      // cheapest place to notice is before it is stored.
      const actual = yield* Effect.tryPromise({
        try: () => sha256Bytes(input.bytes),
        catch: (cause) => storeError("hash-output-image", owner, cause),
      });
      if (actual !== input.contentHash) {
        return yield* storeError(
          "write-output-image",
          owner,
          new Error("The image bytes do not match the hash they were reported under."),
        );
      }
      const fileName = `${digest[1]}${imageFileExtension(input.mediaType)}`;
      const directory = path.join(owner, "outputs");
      const filePath = path.join(directory, fileName);
      yield* fs
        .makeDirectory(directory, { recursive: true })
        .pipe(mapStoreError("make-output-image-directory", directory));
      // Content-addressed, so a figure produced twice is stored once and a
      // rewrite is a no-op rather than a conflict.
      if (!(yield* fs.exists(filePath).pipe(mapStoreError("exists", filePath)))) {
        yield* Effect.scoped(
          Effect.gen(function* () {
            // A temporary directory of its own, the way every other atomic write
            // in this server does it, rather than a name derived from the target.
            // Image writes deliberately do not take the write lease -- a
            // multi-megabyte copy has no business blocking a journal append --
            // so two of them can be in flight at once, and two writers storing
            // the same figure would otherwise derive the same temporary name and
            // the second's rename would look for a file the first had already
            // moved. The scope also takes the directory away again when a write
            // fails, instead of leaving a half-written image beside a real one.
            const temporaryDirectory = yield* fs
              .makeTempDirectoryScoped({ directory, prefix: `${fileName}.` })
              .pipe(mapStoreError("write-output-image", directory));
            yield* Effect.tryPromise({
              try: async () => {
                const temporaryPath = path.join(temporaryDirectory, "image.tmp");
                await NodeFSP.writeFile(temporaryPath, input.bytes);
                await NodeFSP.rename(temporaryPath, filePath);
              },
              catch: (cause) => storeError("write-output-image", filePath, cause),
            });
          }),
        );
      }
      return { fileName };
    });

  /** Every project with a compute directory, for a sweep that has to visit them all. */
  const loadProjectIds = () =>
    Effect.gen(function* () {
      if (!(yield* fs.exists(sessionsRoot).pipe(mapStoreError("exists", sessionsRoot)))) return [];
      const entries = yield* fs
        .readDirectory(sessionsRoot)
        .pipe(mapStoreError("read-sessions-root", sessionsRoot));
      return entries.filter(isSafeSegment).map((entry) => ComputeProjectId.make(entry));
    });

  const loadSession = (projectId: ComputeProjectId, sessionId: ComputeSessionId) =>
    Effect.gen(function* () {
      const directory = yield* sessionDirectory(projectId, sessionId);
      const filePath = path.join(directory, "session.json");
      if (!(yield* fs.exists(filePath).pipe(mapStoreError("exists", filePath)))) return null;
      const contents = yield* fs
        .readFileString(filePath)
        .pipe(mapStoreError("read-session", filePath));
      const decoded = decodeSession(contents);
      if (Option.isNone(decoded)) {
        // Not treated as an absent session: "there is no session here" and "I
        // cannot read the session that is here" are different facts, and only
        // the first is safe to overwrite.
        return yield* storeError(
          "decode-session",
          filePath,
          new Error("The stored compute session record is unreadable."),
        );
      }
      return decoded.value;
    });

  /**
   * Every session of a project that can still be read.
   *
   * Unlike `loadSession`, one unreadable record is skipped rather than fatal.
   * Enumeration is how a client learns a project has sessions at all, and a
   * single torn or future-versioned file must not blank the whole list; the
   * file is left untouched so a later version can still read it, and the
   * warning is what an operator needs to find it.
   */
  const loadSessions = (projectId: ComputeProjectId) =>
    Effect.gen(function* () {
      const projectRoot = yield* joinSegments("load-sessions", projectId);
      if (!(yield* fs.exists(projectRoot).pipe(mapStoreError("exists", projectRoot)))) return [];
      const entries = yield* fs
        .readDirectory(projectRoot)
        .pipe(mapStoreError("read-project-sessions", projectRoot));
      const sessions: ComputeSessionRecord[] = [];
      for (const entry of entries) {
        if (!isSafeSegment(entry)) continue;
        const record = yield* loadSession(projectId, ComputeSessionId.make(entry)).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("compute session record skipped as unreadable", {
              projectId,
              sessionId: entry,
              operation: cause.operation,
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
        if (record !== null) sessions.push(record);
      }
      return sessions.toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    });

  const loadExecutions = (projectId: ComputeProjectId, sessionId: ComputeSessionId) =>
    Effect.gen(function* () {
      const directory = yield* sessionDirectory(projectId, sessionId);
      const executionsRoot = path.join(directory, "executions");
      if (!(yield* fs.exists(executionsRoot).pipe(mapStoreError("exists", executionsRoot)))) {
        return [];
      }
      const entries = yield* fs
        .readDirectory(executionsRoot)
        .pipe(mapStoreError("read-executions", executionsRoot));
      const executions: ComputeExecutionRecord[] = [];
      for (const entry of entries) {
        if (!isSafeSegment(entry)) continue;
        const requestPath = path.join(executionsRoot, entry, "request.json");
        if (!(yield* fs.exists(requestPath).pipe(mapStoreError("exists", requestPath)))) continue;
        const requestText = yield* fs
          .readFileString(requestPath)
          .pipe(mapStoreError("read-execution-request", requestPath));
        const request = decodeRequest(requestText);
        if (Option.isNone(request)) {
          // Skipped, not fatal, for the same reason as `loadSessions`: one
          // unreadable request must not make a whole session's history
          // unreadable, and there is nothing else to be done with a request
          // that cannot be decoded -- it cannot even be marked lost.
          yield* Effect.logWarning("compute execution request skipped as unreadable", {
            projectId,
            sessionId,
            executionId: entry,
          });
          continue;
        }
        if (request.value.sessionId !== sessionId || request.value.executionId !== entry) {
          yield* Effect.logWarning("compute execution request identity did not match its path", {
            projectId,
            sessionId,
            executionId: entry,
          });
          continue;
        }
        const resultPath = path.join(executionsRoot, entry, "result.json");
        const hasResult = yield* fs.exists(resultPath).pipe(mapStoreError("exists", resultPath));
        // A missing or unreadable result is the same fact: the execution was in
        // flight when writing stopped. Recovery repairs it; reading it must not
        // fail, or one torn file would make a whole session unreadable.
        const result = hasResult
          ? decodeResult(
              yield* fs
                .readFileString(resultPath)
                .pipe(mapStoreError("read-execution-result", resultPath)),
            )
          : Option.none<ComputeExecutionResultRecord>();
        const decodedResult = Option.getOrNull(result);
        if (decodedResult !== null && decodedResult.executionId !== request.value.executionId) {
          yield* Effect.logWarning("compute execution result identity did not match its path", {
            projectId,
            sessionId,
            executionId: entry,
          });
          executions.push({ request: request.value, result: null });
        } else {
          executions.push({ request: request.value, result: decodedResult });
        }
      }
      return executions.toSorted((left, right) =>
        left.request.submittedAt.localeCompare(right.request.submittedAt),
      );
    });

  const loadExecution = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId,
  ) =>
    Effect.gen(function* () {
      const directory = yield* executionDirectory(projectId, sessionId, executionId);
      const requestPath = path.join(directory, "request.json");
      if (!(yield* fs.exists(requestPath).pipe(mapStoreError("exists", requestPath)))) return null;
      const requestText = yield* fs
        .readFileString(requestPath)
        .pipe(mapStoreError("read-execution-request", requestPath));
      const request = decodeRequest(requestText);
      if (
        Option.isNone(request) ||
        request.value.sessionId !== sessionId ||
        request.value.executionId !== executionId
      ) {
        return yield* storeError(
          "decode-execution-request",
          requestPath,
          new Error("The stored execution request identity does not match its path."),
        );
      }
      const resultPath = path.join(directory, "result.json");
      if (!(yield* fs.exists(resultPath).pipe(mapStoreError("exists", resultPath)))) {
        return { request: request.value, result: null };
      }
      const result = decodeResult(
        yield* fs
          .readFileString(resultPath)
          .pipe(mapStoreError("read-execution-result", resultPath)),
      );
      if (Option.isNone(result)) return { request: request.value, result: null };
      if (result.value.executionId !== executionId) {
        return yield* storeError(
          "decode-execution-result",
          resultPath,
          new Error("The stored execution result identity does not match its path."),
        );
      }
      return { request: request.value, result: result.value };
    });

  const loadOutputs = (
    projectId: ComputeProjectId,
    sessionId: ComputeSessionId,
    executionId: ComputeExecutionId | null,
  ) =>
    Effect.gen(function* () {
      const owner = yield* outputOwnerDirectory(projectId, sessionId, executionId);
      const filePath = path.join(owner, "output.ndjson");
      const lines = yield* readLines(filePath, "read-output");
      const outputs: ComputeOutput[] = [];
      let corruptLineCount = 0;
      for (const line of lines) {
        const decoded = decodeOutput(line);
        if (Option.isSome(decoded)) outputs.push(decoded.value);
        else corruptLineCount += 1;
      }
      return { outputs, corruptLineCount } satisfies LoadedComputeOutputs;
    });

  const loadJournal = (projectId: ComputeProjectId, sessionId: ComputeSessionId) =>
    Effect.gen(function* () {
      const directory = yield* sessionDirectory(projectId, sessionId);
      const filePath = path.join(directory, "journal.ndjson");
      const lines = yield* readLines(filePath, "read-journal");
      const entries: ComputeSessionJournalEntry[] = [];
      for (const line of lines) {
        const decoded = decodeJournalEntry(line);
        if (Option.isSome(decoded)) entries.push(decoded.value);
      }
      return entries;
    });

  const resolveOutputImage = (ref: ComputeOutputResourceRef) =>
    Effect.gen(function* () {
      const digest = CONTENT_HASH_PATTERN.exec(ref.contentHash);
      if (digest?.[1] === undefined) return null;
      const owner = yield* outputOwnerDirectory(ref.projectId, ref.sessionId, ref.executionId);

      // The record decides, not the request. Everything below is a check
      // against what was stored, so a caller cannot name a file the transcript
      // never mentioned.
      const { outputs } = yield* loadOutputs(ref.projectId, ref.sessionId, ref.executionId);
      const metadata = outputs.find(
        (output) => output._tag === "image" && output.contentHash === ref.contentHash,
      );
      if (metadata === undefined || metadata._tag !== "image") return null;

      const fileName = `${digest[1]}${imageFileExtension(metadata.mediaType)}`;
      const filePath = path.join(owner, "outputs", fileName);
      const info = yield* Effect.tryPromise({
        try: async () => {
          try {
            // `lstat`, not `stat`: a symlink here would let a corrupted or
            // hostile store hand out a signed URL for an arbitrary file.
            return await NodeFSP.lstat(filePath);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw cause;
          }
        },
        catch: (cause) => storeError("inspect-output-image", filePath, cause),
      });
      if (info === null || !info.isFile()) return null;
      if (info.size !== metadata.byteLength) return null;

      const actualHash = yield* Effect.tryPromise({
        try: () => sha256File(filePath),
        catch: (cause) => storeError("hash-output-image", filePath, cause),
      });
      if (actualHash !== ref.contentHash) return null;

      // Belt and braces after the symlink check: the parent directories could
      // themselves be links, and containment is the property that matters.
      const [canonicalRoot, canonicalFile] = yield* Effect.all([
        fs.realPath(config.computeDir),
        fs.realPath(filePath),
      ]).pipe(mapStoreError("canonicalize-output-image", filePath));
      const relative = path.relative(canonicalRoot, canonicalFile);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return null;

      return {
        path: canonicalFile,
        fileName,
        mediaType: metadata.mediaType,
        contentHash: metadata.contentHash,
        byteLength: metadata.byteLength,
        // `mtime.getTime()`, not `mtimeMs`: this revision is pinned into a
        // signed URL and compared against a fresh stat when the URL is served,
        // and the reader sees whole milliseconds. `mtimeMs` carries the
        // filesystem's sub-millisecond precision, so recording it would make
        // the two disagree about an unchanged file and refuse to serve it.
        revision: { size: info.size, mtimeMs: info.mtime.getTime() },
      } satisfies ResolvedComputeOutputImage;
    });

  const measureSessionStorage = (projectId: ComputeProjectId, sessionId: ComputeSessionId) =>
    Effect.gen(function* () {
      const directory = yield* sessionDirectory(projectId, sessionId);
      const executionsRoot = path.join(directory, "executions");
      return yield* Effect.tryPromise({
        try: async (): Promise<ComputeSessionStorage> => {
          let outputBytes = await fileByteLength(`${directory}/output.ndjson`);
          let imageBytes = await directoryByteLength(`${directory}/outputs`);
          let entries: ReadonlyArray<string> = [];
          try {
            entries = await NodeFSP.readdir(executionsRoot);
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
          }
          for (const entry of entries) {
            if (!isSafeSegment(entry)) continue;
            outputBytes += await fileByteLength(`${executionsRoot}/${entry}/output.ndjson`);
            imageBytes += await directoryByteLength(`${executionsRoot}/${entry}/outputs`);
          }
          return {
            status: "retained",
            outputBytes,
            imageBytes,
            totalBytes: outputBytes + imageBytes,
            removedAt: null,
          };
        },
        catch: (cause) => storeError("measure-session-storage", directory, cause),
      });
    });

  /**
   * Reclaims a finished session's bulky data and keeps its history.
   *
   * Output lines and image files go; the session record, its journal, and every
   * execution request and result stay. A scientist looking at last month's work
   * should still see what they ran and how it ended, and should be told the
   * figures are gone rather than shown a session that appears never to have
   * produced any.
   *
   * Nothing in the server calls this yet, deliberately: *which* sessions to trim
   * and after how long is a retention policy the foundation document defers, and
   * picking a schedule here would be deciding it by accident. What is settled is
   * that reclaiming space must not erase history, which is what this does and
   * what its test holds it to.
   */
  const removeDisposableSessionData = (record: ComputeSessionRecord, removedAt: string) =>
    writeLock.withPermits(1)(
      Effect.gen(function* () {
        const directory = yield* sessionDirectory(record.projectId, record.sessionId);
        const measured = yield* measureSessionStorage(record.projectId, record.sessionId);
        const updated = {
          ...record,
          storage: {
            status: "metadata-only" as const,
            outputBytes: 0,
            imageBytes: 0,
            totalBytes: 0,
            removedAt,
          },
        } satisfies ComputeSessionRecord;
        const filePath = path.join(directory, "session.json");
        const contents = yield* encodeSession(updated).pipe(
          mapStoreError("encode-session", filePath),
        );
        // The record is rewritten first. A crash between the two leaves data on
        // disk that the record calls gone, which is a wasted byte; the reverse
        // leaves a record promising data that is not there, which is a lie.
        yield* atomicWrite(filePath, contents);
        yield* Effect.tryPromise({
          try: async () => {
            const executionsRoot = `${directory}/executions`;
            await NodeFSP.rm(`${directory}/output.ndjson`, { force: true });
            await NodeFSP.rm(`${directory}/outputs`, { force: true, recursive: true });
            let entries: ReadonlyArray<string> = [];
            try {
              entries = await NodeFSP.readdir(executionsRoot);
            } catch (cause) {
              if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
            }
            for (const entry of entries) {
              if (!isSafeSegment(entry)) continue;
              await NodeFSP.rm(`${executionsRoot}/${entry}/output.ndjson`, { force: true });
              await NodeFSP.rm(`${executionsRoot}/${entry}/outputs`, {
                force: true,
                recursive: true,
              });
            }
          },
          catch: (cause) => storeError("remove-disposable-session-data", directory, cause),
        });
        // Said in the journal, not only in the log: "the figures are gone" is
        // exactly the kind of state the journal exists to explain, and a reader
        // a month later has the journal and not the log.
        const journal = yield* loadJournal(record.projectId, record.sessionId).pipe(
          Effect.orElseSucceed((): ReadonlyArray<ComputeSessionJournalEntry> => []),
        );
        yield* appendJournalEntry(record.projectId, record.sessionId, {
          sequence: (journal.at(-1)?.sequence ?? -1) + 1,
          observedAt: removedAt,
          event: "storage-trimmed",
          generation: record.generation,
          executionId: null,
          detail: `Reclaimed ${String(measured.totalBytes)} bytes of output and images. What ran and how it ended was kept.`,
        });
        return updated;
      }),
    );

  return LocalComputeStore.of({
    writeSession,
    appendJournal,
    writeExecutionRequest,
    writeExecutionResult,
    appendOutputs,
    writeOutputImage,
    loadProjectIds,
    loadSessions,
    loadSession,
    loadExecutions,
    loadExecution,
    loadOutputs,
    loadJournal,
    resolveOutputImage,
    measureSessionStorage,
    removeDisposableSessionData,
  });
});

export const layer = Layer.effect(LocalComputeStore, make);
