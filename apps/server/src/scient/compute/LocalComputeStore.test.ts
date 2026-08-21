// @effect-diagnostics nodeBuiltinImport:off -- these tests corrupt files and plant symlinks on purpose.
import * as NodeFSP from "node:fs/promises";

import {
  ComputeExecutionRequestRecord,
  ComputeExecutionId,
  ComputeExecutionResultRecord,
  ComputeOutput,
  ComputeProjectId,
  ComputeSessionJournalEntry,
  ComputeSessionRecord,
  type ComputeSessionId,
} from "@scientfactory/compute";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import {
  LocalComputeStore,
  MAXIMUM_COMPUTE_OUTPUT_IMAGE_BYTES,
  layer,
  type LocalComputeStoreError,
} from "./LocalComputeStore.ts";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const decodeSession = Schema.decodeUnknownSync(ComputeSessionRecord);
const decodeRequest = Schema.decodeUnknownSync(ComputeExecutionRequestRecord);
const decodeResult = Schema.decodeUnknownSync(ComputeExecutionResultRecord);
const decodeOutput = Schema.decodeUnknownSync(ComputeOutput);
const decodeJournalEntry = Schema.decodeUnknownSync(ComputeSessionJournalEntry);
const encodeRequestJson = Schema.encodeSync(Schema.fromJsonString(ComputeExecutionRequestRecord));

const PROJECT_ID = ComputeProjectId.make("project-1");

const session = decodeSession({
  sessionId: "session-1",
  projectId: "project-1",
  label: "Analysis",
  languageId: "python",
  transportKind: "jupyter-bridge",
  workingDirectory: "/projects/one",
  runtime: null,
  identity: null,
  environmentFingerprint: null,
  generation: 1,
  status: "ready",
  activity: "idle",
  activeExecutionId: null,
  pendingCount: 0,
  storage: {
    status: "retained",
    outputBytes: 0,
    imageBytes: 0,
    totalBytes: 0,
    removedAt: null,
  },
  createdAt: OBSERVED_AT,
  lastActivityAt: OBSERVED_AT,
  closedAt: null,
  lostReason: null,
});

const SESSION_ID: ComputeSessionId = session.sessionId;

const request = decodeRequest({
  executionId: "execution-1",
  sessionId: "session-1",
  generation: 1,
  code: "print(1)",
  codeHash: "sha256:code",
  source: { _tag: "console" },
  submittedAt: OBSERVED_AT,
  environmentFingerprint: null,
});

const EXECUTION_ID: ComputeExecutionId = request.executionId;

const runningResult = decodeResult({
  executionId: "execution-1",
  status: "running",
  outcome: null,
  queuePosition: null,
  startedAt: OBSERVED_AT,
  finishedAt: null,
  diagnostics: [],
  outputCount: 0,
  outputBytes: 0,
  truncated: false,
  failureReason: null,
});

const succeededResult = decodeResult({
  ...runningResult,
  status: "succeeded",
  outcome: "succeeded",
  finishedAt: "2026-08-20T09:00:02.000Z",
  outputCount: 1,
  outputBytes: 6,
});

const streamOutput = decodeOutput({
  _tag: "stream",
  sequence: 0,
  observedAt: OBSERVED_AT,
  stream: "stdout",
  text: "hello",
});

const journalEntry = decodeJournalEntry({
  sequence: 0,
  observedAt: OBSERVED_AT,
  event: "session-created",
  generation: 1,
  executionId: null,
  detail: null,
});

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"));
  return `sha256:${hex.join("")}`;
};

const PNG_HASH = await sha256(PNG_BYTES);

const imageOutput = decodeOutput({
  _tag: "image",
  sequence: 1,
  observedAt: OBSERVED_AT,
  mediaType: "image/png",
  contentHash: PNG_HASH,
  byteLength: PNG_BYTES.byteLength,
  width: 4,
  height: 3,
});

const IMAGE_FILE_NAME = `${PNG_HASH.slice("sha256:".length)}.png`;
const SVG_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="2"/></svg>';
const SVG_BYTES = new TextEncoder().encode(SVG_SOURCE);
const SVG_HASH = await sha256(SVG_BYTES);
const SVG_FILE_NAME = `${SVG_HASH.slice("sha256:".length)}.svg`;

/**
 * A store over a throwaway state directory.
 *
 * `use` opens and closes the store, so a test can prove a fact survives the
 * lifetime that wrote it rather than reading back its own in-memory state.
 */
const harness = (prefix: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix });
    const storeLayer = layer.pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      Layer.provideMerge(NodeServices.layer),
    );
    const computeDir = path.join(baseDir, "userdata", "compute");
    const sessionsRoot = path.join(computeDir, "sessions");
    const sessionDirectory = path.join(sessionsRoot, PROJECT_ID, SESSION_ID);
    const executionDirectory = path.join(sessionDirectory, "executions", EXECUTION_ID);
    const use = <A, E>(
      body: Effect.Effect<A, E, LocalComputeStore | FileSystem.FileSystem | Path.Path>,
    ) => Effect.scoped(body.pipe(Effect.provide(storeLayer)));
    return { baseDir, computeDir, sessionsRoot, sessionDirectory, executionDirectory, use };
  });

/** Writes a whole finished execution, which most tests need before they start. */
const seed = Effect.gen(function* () {
  const store = yield* LocalComputeStore;
  yield* store.writeSession(session);
  yield* store.appendJournal(PROJECT_ID, SESSION_ID, journalEntry);
  yield* store.writeExecutionRequest(PROJECT_ID, request);
  yield* store.writeExecutionResult(PROJECT_ID, SESSION_ID, succeededResult);
  yield* store.appendOutputs({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    outputs: [streamOutput, imageOutput],
  });
  yield* store.writeOutputImage({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    executionId: EXECUTION_ID,
    contentHash: PNG_HASH,
    mediaType: "image/png",
    bytes: PNG_BYTES,
  });
});

describe("LocalComputeStore durability", () => {
  it.effect("keeps a session, its journal, its executions and its output across lifetimes", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-");

      yield* use(seed);

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          expect(yield* store.loadProjectIds()).toEqual([PROJECT_ID]);
          expect(yield* store.loadSessions(PROJECT_ID)).toEqual([session]);
          expect(yield* store.loadSession(PROJECT_ID, SESSION_ID)).toEqual(session);
          expect(yield* store.loadJournal(PROJECT_ID, SESSION_ID)).toEqual([journalEntry]);
          expect(yield* store.loadExecutions(PROJECT_ID, SESSION_ID)).toEqual([
            { request, result: succeededResult },
          ]);
          expect(yield* store.loadOutputs(PROJECT_ID, SESSION_ID, EXECUTION_ID)).toEqual({
            outputs: [streamOutput, imageOutput],
            corruptLineCount: 0,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports no session where nothing was ever written", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-empty-");
      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          expect(yield* store.loadProjectIds()).toEqual([]);
          expect(yield* store.loadSessions(PROJECT_ID)).toEqual([]);
          expect(yield* store.loadSession(PROJECT_ID, SESSION_ID)).toBeNull();
          expect(yield* store.loadExecutions(PROJECT_ID, SESSION_ID)).toEqual([]);
          expect(yield* store.loadJournal(PROJECT_ID, SESSION_ID)).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("advances a result without disturbing what was submitted", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-progress-");

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          yield* store.writeExecutionResult(PROJECT_ID, SESSION_ID, runningResult);
          yield* store.writeExecutionResult(PROJECT_ID, SESSION_ID, succeededResult);
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          // The request is written once and the result many times, which is the
          // whole reason they are separate files: a crash mid-update can only
          // ever damage the half that was being rewritten.
          expect(yield* store.loadExecutions(PROJECT_ID, SESSION_ID)).toEqual([
            { request, result: succeededResult },
          ]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to rewrite an immutable execution request", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-immutable-request-");
      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          const failure = yield* Effect.flip(store.writeExecutionRequest(PROJECT_ID, request));
          expect(String(failure.cause)).toContain("immutable");
          expect(yield* store.loadExecution(PROJECT_ID, SESSION_ID, EXECUTION_ID)).toEqual({
            request,
            result: null,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("writes a batch of output as one unit that nothing can interleave", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-order-");
      const outputs = Array.from({ length: 200 }, (_unused, index) =>
        decodeOutput({
          _tag: "stream",
          sequence: index,
          observedAt: OBSERVED_AT,
          stream: "stdout",
          text: `line ${index}`,
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          // Two concurrent batches: each is one append, so they may land in
          // either order, but neither may be split by the other.
          yield* Effect.all(
            [
              store.appendOutputs({
                projectId: PROJECT_ID,
                sessionId: SESSION_ID,
                executionId: EXECUTION_ID,
                outputs: outputs.slice(0, 100),
              }),
              store.appendOutputs({
                projectId: PROJECT_ID,
                sessionId: SESSION_ID,
                executionId: EXECUTION_ID,
                outputs: outputs.slice(100),
              }),
            ],
            { concurrency: "unbounded" },
          );
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          const loaded = yield* store.loadOutputs(PROJECT_ID, SESSION_ID, EXECUTION_ID);
          expect(loaded.corruptLineCount).toBe(0);
          const sequences = loaded.outputs.map((output) => output.sequence);
          const offset = sequences[0] === 0 ? 0 : 100;
          expect(sequences.slice(0, 100)).toEqual(
            Array.from({ length: 100 }, (_unused, index) => index + offset),
          );
          expect(sequences.slice(100)).toEqual(
            Array.from({ length: 100 }, (_unused, index) => index + (100 - offset)),
          );
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stores output that belongs to no execution against the session", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-session-output-");

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          yield* store.appendOutputs({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: null,
            outputs: [streamOutput],
          });

          // Not in the execution's transcript: a stray thread's print belongs to
          // the session, and attributing it to whichever cell happens to be
          // running would put it inside another execution's output.
          const ofExecution = yield* store.loadOutputs(PROJECT_ID, SESSION_ID, EXECUTION_ID);
          expect(ofExecution.outputs).toEqual([]);
          const ofSession = yield* store.loadOutputs(PROJECT_ID, SESSION_ID, null);
          expect(ofSession.outputs).toEqual([streamOutput]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("LocalComputeStore corruption", () => {
  it.effect("refuses a stored execution whose identity does not match its path", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-identity-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
        }),
      );
      yield* fs.writeFileString(
        path.join(executionDirectory, "request.json"),
        encodeRequestJson({
          ...request,
          executionId: ComputeExecutionId.make("different-execution"),
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          const failure = yield* Effect.flip(
            store.loadExecution(PROJECT_ID, SESSION_ID, EXECUTION_ID),
          );
          expect(String(failure.cause)).toContain("identity does not match");
          expect(yield* store.loadExecutions(PROJECT_ID, SESSION_ID)).toEqual([]);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to read a session record it cannot decode rather than calling it absent", () =>
    Effect.gen(function* () {
      const { use, sessionDirectory } = yield* harness("scient-compute-store-torn-session-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* use(seed);
      yield* fs.writeFileString(path.join(sessionDirectory, "session.json"), '{"sessionId":"ses');

      const failure = yield* use(
        Effect.flip(
          Effect.gen(function* () {
            const store = yield* LocalComputeStore;
            return yield* store.loadSession(PROJECT_ID, SESSION_ID);
          }),
        ),
      );
      // "There is no session here" and "I cannot read the session that is here"
      // are different facts, and only the first is safe to overwrite.
      expect(failure.operation).toBe("decode-session");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("lists the sessions it can still read when one record is unreadable", () =>
    Effect.gen(function* () {
      const { use, sessionsRoot } = yield* harness("scient-compute-store-torn-listing-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const second = decodeSession({
        ...session,
        sessionId: "session-2",
        createdAt: "2026-08-20T10:00:00.000Z",
      });

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeSession(second);
        }),
      );
      yield* fs.writeFileString(
        path.join(sessionsRoot, PROJECT_ID, SESSION_ID, "session.json"),
        "{}",
      );

      const sessions = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadSessions(PROJECT_ID);
        }),
      );
      // One torn file must not blank a project's whole session list. The file is
      // left where it is, so a version that can read it still will.
      expect(sessions).toEqual([second]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports an execution that stopped before its result was written", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-no-result-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const resultPath = path.join(executionDirectory, "result.json");

      yield* use(seed);
      // What a crash between the request and the first result looks like, and
      // what a torn result looks like: recovery has to see both the same way,
      // because in both cases the execution was in flight when writing stopped.
      yield* fs.remove(resultPath);

      const withoutResult = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadExecutions(PROJECT_ID, SESSION_ID);
        }),
      );
      expect(withoutResult).toEqual([{ request, result: null }]);

      yield* fs.writeFileString(resultPath, '{"executionId"');
      const withTornResult = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadExecutions(PROJECT_ID, SESSION_ID);
        }),
      );
      expect(withTornResult).toEqual([{ request, result: null }]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("skips an unreadable request instead of losing a session's whole history", () =>
    Effect.gen(function* () {
      const { use, executionDirectory, sessionDirectory } = yield* harness(
        "scient-compute-store-torn-request-",
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const secondRequest = decodeRequest({
        ...request,
        executionId: "execution-2",
        submittedAt: "2026-08-20T09:00:05.000Z",
      });

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          yield* store.writeExecutionRequest(PROJECT_ID, secondRequest);
        }),
      );
      yield* fs.writeFileString(path.join(executionDirectory, "request.json"), "not json");

      const executions = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadExecutions(PROJECT_ID, SESSION_ID);
        }),
      );
      expect(executions).toEqual([{ request: secondRequest, result: null }]);
      // Skipped, not deleted: nothing here throws away what it cannot read.
      expect(yield* fs.exists(path.join(sessionDirectory, "executions", "execution-1"))).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("counts a torn output line and keeps the rest of the transcript", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-torn-output-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const outputPath = path.join(executionDirectory, "output.ndjson");

      yield* use(seed);
      const contents = yield* fs.readFileString(outputPath);
      // A process killed mid-append leaves exactly this: whole lines, then one
      // that stops. The whole lines are still the truth.
      yield* fs.writeFileString(outputPath, `${contents}{"_tag":"stream","sequ`);

      const loaded = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadOutputs(PROJECT_ID, SESSION_ID, EXECUTION_ID);
        }),
      );
      expect(loaded.outputs).toEqual([streamOutput, imageOutput]);
      expect(loaded.corruptLineCount).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ignores a journal line it cannot read", () =>
    Effect.gen(function* () {
      const { use, sessionDirectory } = yield* harness("scient-compute-store-torn-journal-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const journalPath = path.join(sessionDirectory, "journal.ndjson");

      yield* use(seed);
      const contents = yield* fs.readFileString(journalPath);
      yield* fs.writeFileString(journalPath, `${contents}{"sequence":1,"event":"who-knows"}\n`);

      const entries = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadJournal(PROJECT_ID, SESSION_ID);
        }),
      );
      // The journal explains history and answers no question a caller depends
      // on, so an entry from a version this one does not know is dropped rather
      // than made fatal.
      expect(entries).toEqual([journalEntry]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("LocalComputeStore images", () => {
  it.effect("stores an image once however many times it is produced", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-image-dedupe-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const written = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          const write = () =>
            store.writeOutputImage({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: EXECUTION_ID,
              contentHash: PNG_HASH,
              mediaType: "image/png",
              bytes: PNG_BYTES,
            });
          return [yield* write(), yield* write()];
        }),
      );

      // The name is derived from the hash and never carried in a reference, so a
      // figure produced twice costs one file and a rewrite is a no-op.
      expect(written.map((result) => result.fileName)).toEqual([IMAGE_FILE_NAME, IMAGE_FILE_NAME]);
      expect(yield* fs.readDirectory(path.join(executionDirectory, "outputs"))).toEqual([
        IMAGE_FILE_NAME,
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses bytes that do not match the hash they were reported under", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-image-mismatch-");
      const otherHash = yield* Effect.promise(() => sha256(new Uint8Array([9, 9, 9])));

      const failure = yield* use(
        Effect.flip(
          Effect.gen(function* () {
            const store = yield* LocalComputeStore;
            yield* store.writeSession(session);
            return yield* store.writeOutputImage({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: null,
              contentHash: otherHash,
              mediaType: "image/png",
              bytes: PNG_BYTES,
            });
          }),
        ),
      );
      // Checked on the way in, not only on the way out: a file whose name
      // disagreed with its bytes would be permanently unresolvable, and the
      // cheapest place to notice is before it is stored.
      expect(failure.operation).toBe("write-output-image");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses a content hash that is not a sha256 digest", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-image-hash-shape-");

      const failure = yield* use(
        Effect.flip(
          Effect.gen(function* () {
            const store = yield* LocalComputeStore;
            return yield* store.writeOutputImage({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: null,
              // The file name is derived from this, so anything that is not a
              // hex digest is a way of choosing a path.
              contentHash: "sha256:../../../../etc/passwd",
              mediaType: "image/png",
              bytes: PNG_BYTES,
            });
          }),
        ),
      );
      expect(failure.operation).toBe("write-output-image");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses an image beyond the size ceiling", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-image-ceiling-");

      const failure = yield* use(
        Effect.flip(
          Effect.gen(function* () {
            const store = yield* LocalComputeStore;
            return yield* store.writeOutputImage({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: null,
              contentHash: `sha256:${"0".repeat(64)}`,
              mediaType: "image/png",
              bytes: new Uint8Array(MAXIMUM_COMPUTE_OUTPUT_IMAGE_BYTES + 1),
            });
          }),
        ),
      );
      // Refused before it is hashed: filling a disk is worse than losing a
      // figure, and the size is known without reading the bytes.
      expect(failure.operation).toBe("write-output-image");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("resolves an image the transcript accounts for", () =>
    Effect.gen(function* () {
      const { use, computeDir } = yield* harness("scient-compute-store-image-resolve-");

      const resolved = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* seed;
          return yield* store.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: PNG_HASH,
          });
        }),
      );

      expect(resolved).toMatchObject({
        fileName: IMAGE_FILE_NAME,
        mediaType: "image/png",
        contentHash: PNG_HASH,
        byteLength: PNG_BYTES.byteLength,
      });
      expect(resolved?.revision.size).toBe(PNG_BYTES.byteLength);
      // Whole milliseconds. This revision is pinned into a signed URL and
      // compared against a fresh stat when that URL is served, and the reader
      // sees a `Date`; sub-millisecond precision here would make the two
      // disagree about a file nothing had touched.
      expect(resolved?.revision.mtimeMs).toBe(Math.trunc(resolved?.revision.mtimeMs ?? 0.5));
      // The resolved path is what becomes a signed URL, so it has to be inside
      // the compute directory once both ends are canonicalized -- on macOS the
      // temp directory is itself a symlink, so the raw paths would not match.
      const canonicalComputeDir = yield* Effect.promise(() => NodeFSP.realpath(computeDir));
      expect(resolved?.path.startsWith(canonicalComputeDir)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stores and resolves SVG output with its truthful media extension", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-svg-resolve-");
      const svgOutput = decodeOutput({
        _tag: "image",
        sequence: 1,
        observedAt: OBSERVED_AT,
        mediaType: "image/svg+xml",
        contentHash: SVG_HASH,
        byteLength: SVG_BYTES.byteLength,
        width: null,
        height: null,
      });

      const resolved = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          yield* store.appendOutputs({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            outputs: [svgOutput],
          });
          yield* store.writeOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: SVG_HASH,
            mediaType: "image/svg+xml",
            bytes: SVG_BYTES,
          });
          return yield* store.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: SVG_HASH,
          });
        }),
      );

      expect(resolved).toMatchObject({
        fileName: SVG_FILE_NAME,
        mediaType: "image/svg+xml",
        contentHash: SVG_HASH,
        byteLength: SVG_BYTES.byteLength,
      });
      expect(resolved?.path.endsWith(`/${SVG_FILE_NAME}`)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to resolve an image the transcript never mentioned", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-image-unlisted-");
      const other = new Uint8Array([1, 1, 1, 1]);
      const otherHash = yield* Effect.promise(() => sha256(other));

      const resolved = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* seed;
          // The bytes are stored, so only the record's silence stops this. That
          // is the point: the transcript decides what may be served, not the
          // caller and not the directory.
          yield* store.writeOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: otherHash,
            mediaType: "image/png",
            bytes: other,
          });
          return yield* store.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: otherHash,
          });
        }),
      );
      expect(resolved).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to resolve an image whose bytes changed under it", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-image-swapped-");
      const path = yield* Path.Path;

      yield* use(seed);
      // Same length, different content, so the size check passes and only the
      // hash can catch it.
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          path.join(executionDirectory, "outputs", IMAGE_FILE_NAME),
          new Uint8Array(PNG_BYTES.byteLength).fill(7),
        ),
      );

      const resolved = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: PNG_HASH,
          });
        }),
      );
      expect(resolved).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to resolve an image that is a symlink to somewhere else", () =>
    Effect.gen(function* () {
      const { use, baseDir, executionDirectory } = yield* harness(
        "scient-compute-store-image-symlink-",
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imagePath = path.join(executionDirectory, "outputs", IMAGE_FILE_NAME);
      const outside = path.join(baseDir, "outside.png");

      yield* use(seed);
      yield* fs.writeFileString(outside, "secret");
      yield* Effect.promise(async () => {
        await NodeFSP.rm(imagePath);
        await NodeFSP.symlink(outside, imagePath);
      });

      const resolved = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.resolveOutputImage({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            contentHash: PNG_HASH,
          });
        }),
      );
      // A resolved path becomes a signed URL, so a link out of the store would
      // be a way to have the server hand out any file it can read.
      expect(resolved).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("LocalComputeStore path safety", () => {
  // Every one of these decodes as an identifier -- both id types are bounded
  // non-empty strings and nothing more -- and every one of them is a way of
  // naming a directory other than the one intended.
  const unusableSegments = ["..", "../..", "../../etc", ".", "a/b", " ", "x y", "-leading"];

  it.effect("refuses an identifier that is not a single ordinary path segment", () =>
    Effect.gen(function* () {
      const { use, computeDir, sessionsRoot } = yield* harness("scient-compute-store-traversal-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const failures: ReadonlyArray<LocalComputeStoreError> = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* Effect.all(
            unusableSegments.map((segment) =>
              Effect.flip(store.writeSession(decodeSession({ ...session, sessionId: segment }))),
            ),
          );
        }),
      );

      expect(failures.map((failure) => failure.operation)).toEqual(
        unusableSegments.map(() => "session-directory"),
      );
      // Nothing reached the places those names point at.
      expect(yield* fs.exists(path.join(sessionsRoot, "session.json"))).toBe(false);
      expect(yield* fs.exists(path.join(computeDir, "etc"))).toBe(false);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("refuses to resolve an image through a traversing identifier", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-traversal-resolve-");

      const failure = yield* use(
        Effect.flip(
          Effect.gen(function* () {
            const store = yield* LocalComputeStore;
            return yield* store.resolveOutputImage({
              projectId: ComputeProjectId.make(".."),
              sessionId: SESSION_ID,
              executionId: EXECUTION_ID,
              contentHash: PNG_HASH,
            });
          }),
        ),
      );
      expect(failure.operation).toBe("execution-directory");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("ignores a directory whose name it would not have written", () =>
    Effect.gen(function* () {
      const { use, sessionsRoot } = yield* harness("scient-compute-store-stray-directory-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* use(seed);
      yield* fs.makeDirectory(path.join(sessionsRoot, ".hidden"), { recursive: true });

      const projectIds = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.loadProjectIds();
        }),
      );
      // The same allow list that decides what may be written decides what is
      // read back, so nothing dropped into the directory becomes a project.
      expect(projectIds).toEqual([PROJECT_ID]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

describe("LocalComputeStore storage accounting", () => {
  it.effect("measures output and image bytes separately", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-measure-");

      const storage = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* seed;
          yield* store.appendOutputs({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: null,
            outputs: [streamOutput],
          });
          return yield* store.measureSessionStorage(PROJECT_ID, SESSION_ID);
        }),
      );

      expect(storage.status).toBe("retained");
      expect(storage.imageBytes).toBe(PNG_BYTES.byteLength);
      expect(storage.outputBytes).toBeGreaterThan(0);
      expect(storage.totalBytes).toBe(storage.outputBytes + storage.imageBytes);
      expect(storage.removedAt).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps what a session did when it reclaims what it produced", () =>
    Effect.gen(function* () {
      const { use, sessionDirectory, executionDirectory } = yield* harness(
        "scient-compute-store-trim-",
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const removedAt = "2026-08-21T00:00:00.000Z";

      const trimmed = yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* seed;
          return yield* store.removeDisposableSessionData(session, removedAt);
        }),
      );

      expect(trimmed.storage).toEqual({
        status: "metadata-only",
        outputBytes: 0,
        imageBytes: 0,
        totalBytes: 0,
        removedAt,
      });

      // Gone: the bulk.
      expect(yield* fs.exists(path.join(executionDirectory, "output.ndjson"))).toBe(false);
      expect(yield* fs.exists(path.join(executionDirectory, "outputs"))).toBe(false);
      // Kept: what was run and how it ended. Someone looking at last month's
      // work should still see that, and be told the figures are gone rather
      // than shown a session that appears to have produced none.
      expect(yield* fs.exists(path.join(executionDirectory, "request.json"))).toBe(true);
      expect(yield* fs.exists(path.join(executionDirectory, "result.json"))).toBe(true);
      expect(yield* fs.exists(path.join(sessionDirectory, "journal.ndjson"))).toBe(true);

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          // The record is rewritten before the data is removed, so a crash
          // between the two wastes a byte instead of promising data that is not
          // there.
          expect(yield* store.loadSession(PROJECT_ID, SESSION_ID)).toEqual(trimmed);
          expect(yield* store.loadExecutions(PROJECT_ID, SESSION_ID)).toEqual([
            { request, result: succeededResult },
          ]);
          // The trim is in the journal too, so a reader a month later is told
          // why the figures are gone rather than left to infer it.
          const journal = yield* store.loadJournal(PROJECT_ID, SESSION_ID);
          expect(journal[0]).toEqual(journalEntry);
          expect(journal[1]).toMatchObject({
            sequence: journalEntry.sequence + 1,
            event: "storage-trimmed",
            observedAt: removedAt,
            executionId: null,
          });
          expect(journal).toHaveLength(2);
          expect(
            yield* store.resolveOutputImage({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: EXECUTION_ID,
              contentHash: PNG_HASH,
            }),
          ).toBeNull();
          expect(yield* store.measureSessionStorage(PROJECT_ID, SESSION_ID)).toMatchObject({
            totalBytes: 0,
          });
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

/**
 * The store under the load a real session puts on it.
 *
 * A store that is right one call at a time can still be wrong when a kernel is
 * printing as fast as it can: batches interleave, two figures land at once, a
 * lifetime ends in the middle of a line. Each of these asserts what survived
 * rather than that nothing threw.
 */
describe("LocalComputeStore under load", () => {
  const streamAt = (sequence: number, text: string) =>
    decodeOutput({ _tag: "stream", sequence, observedAt: OBSERVED_AT, stream: "stdout", text });

  const journalAt = (sequence: number) =>
    decodeJournalEntry({
      sequence,
      observedAt: OBSERVED_AT,
      event: "session-created",
      generation: 1,
      executionId: null,
      detail: null,
    });

  const loadTranscript = Effect.gen(function* () {
    const store = yield* LocalComputeStore;
    return yield* store.loadOutputs(PROJECT_ID, SESSION_ID, EXECUTION_ID);
  });

  it.effect("keeps every batch whole when a hundred writers append at once", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-writers-");
      const writers = 100;
      const perWriter = 5;

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          yield* store.writeExecutionRequest(PROJECT_ID, request);
          yield* Effect.forEach(
            Array.from({ length: writers }, (_, writer) => writer),
            (writer) =>
              Effect.all([
                store.appendOutputs({
                  projectId: PROJECT_ID,
                  sessionId: SESSION_ID,
                  executionId: EXECUTION_ID,
                  outputs: Array.from({ length: perWriter }, (_, index) =>
                    streamAt(writer * perWriter + index, `writer-${writer}`),
                  ),
                }),
                store.appendJournal(PROJECT_ID, SESSION_ID, journalAt(writer)),
              ]),
            { concurrency: "unbounded", discard: true },
          );
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          const loaded = yield* loadTranscript;
          // Nothing torn and nothing lost.
          expect(loaded.corruptLineCount).toBe(0);
          expect(loaded.outputs).toHaveLength(writers * perWriter);
          expect(new Set(loaded.outputs.map((output) => output.sequence)).size).toBe(
            writers * perWriter,
          );
          // And no batch split down the middle: each writer's five lines are
          // still five consecutive lines, whoever else was writing at the time.
          const texts = loaded.outputs.map((output) =>
            output._tag === "stream" ? output.text : "",
          );
          for (let writer = 0; writer < writers; writer += 1) {
            const label = `writer-${writer}`;
            const start = texts.indexOf(label);
            expect(texts.slice(start, start + perWriter)).toEqual(Array(perWriter).fill(label));
          }
          expect(yield* store.loadJournal(PROJECT_ID, SESSION_ID)).toHaveLength(writers);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("stores one file per distinct figure however many writers arrive together", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-figures-");
      const path = yield* Path.Path;
      const variants = 12;
      const distinct = yield* Effect.promise(async () => {
        const images: Array<{ readonly bytes: Uint8Array; readonly hash: string }> = [];
        for (let index = 0; index < variants; index += 1) {
          const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, index + 16, 2, 3, 4]);
          images.push({ bytes, hash: await sha256(bytes) });
        }
        return images;
      });

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          // The same figure a dozen times over and a dozen different ones, all
          // at once: a plot redrawn in a loop, and a cell that draws panels.
          yield* Effect.forEach(
            [
              ...Array.from({ length: variants }, () => ({ bytes: PNG_BYTES, hash: PNG_HASH })),
              ...distinct,
            ],
            (image) =>
              store.writeOutputImage({
                projectId: PROJECT_ID,
                sessionId: SESSION_ID,
                executionId: EXECUTION_ID,
                contentHash: image.hash,
                mediaType: "image/png",
                bytes: image.bytes,
              }),
            { concurrency: "unbounded", discard: true },
          );
        }),
      );

      const stored = yield* Effect.promise(() =>
        NodeFSP.readdir(path.join(executionDirectory, "outputs")),
      );
      // One file per distinct figure and nothing else in the directory: no
      // temporary left by a writer that lost a race, and no second copy of the
      // one that was produced over and over.
      expect(stored.toSorted()).toEqual(
        [
          IMAGE_FILE_NAME,
          ...distinct.map((image) => `${image.hash.slice("sha256:".length)}.png`),
        ].toSorted(),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads thousands of lines back in the order they were written", () =>
    Effect.gen(function* () {
      const { use } = yield* harness("scient-compute-store-transcript-");
      const batches = 40;
      const perBatch = 50;

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.writeSession(session);
          for (let batch = 0; batch < batches; batch += 1) {
            yield* store.appendOutputs({
              projectId: PROJECT_ID,
              sessionId: SESSION_ID,
              executionId: EXECUTION_ID,
              outputs: Array.from({ length: perBatch }, (_, index) =>
                streamAt(batch * perBatch + index, "x".repeat(64)),
              ),
            });
          }
        }),
      );

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          const loaded = yield* loadTranscript;
          expect(loaded.corruptLineCount).toBe(0);
          expect(loaded.outputs.map((output) => output.sequence)).toEqual(
            Array.from({ length: batches * perBatch }, (_, index) => index),
          );
          const measured = yield* store.measureSessionStorage(PROJECT_ID, SESSION_ID);
          // Measured from the file, so it counts the envelope around each line
          // as well as the text. What it must never be is zero or an estimate.
          expect(measured.outputBytes).toBeGreaterThan(batches * perBatch * 64);
          expect(measured.imageBytes).toBe(0);
          expect(measured.totalBytes).toBe(measured.outputBytes);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reads what it can from a transcript damaged anywhere in it", () =>
    Effect.gen(function* () {
      const { use, executionDirectory } = yield* harness("scient-compute-store-damage-");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const total = 200;
      const outputPath = path.join(executionDirectory, "output.ndjson");

      yield* use(
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          yield* store.appendOutputs({
            projectId: PROJECT_ID,
            sessionId: SESSION_ID,
            executionId: EXECUTION_ID,
            outputs: Array.from({ length: total }, (_, index) => streamAt(index, `line-${index}`)),
          });
        }),
      );
      const original = yield* fs.readFileString(outputPath);

      // A deterministic walk over the whole file rather than one hand-picked
      // offset: damage inside a line, damage on a newline that welds two lines
      // together, and damage in the last line are three different failures, and
      // a reader has to come back from all of them.
      let seed = 20260820;
      const nextOffset = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed % original.length;
      };
      for (let attempt = 0; attempt < 24; attempt += 1) {
        const offset = nextOffset();
        // A raw NUL is not legal inside a JSON string, so whatever line it lands
        // in stops decoding, and no attempt can quietly still parse.
        yield* fs.writeFileString(
          outputPath,
          `${original.slice(0, offset)}\u0000${original.slice(offset + 1)}`,
        );
        const loaded = yield* use(loadTranscript);
        expect(loaded.corruptLineCount).toBeGreaterThanOrEqual(1);
        // One damaged byte costs one line, or two where it welded a pair.
        expect(loaded.outputs.length).toBeGreaterThanOrEqual(total - 2);
      }

      // Truncation is the crash case: the last line has no newline under it.
      yield* fs.writeFileString(outputPath, original.slice(0, original.indexOf("\n", 400) + 40));
      const cut = yield* use(loadTranscript);
      expect(cut.corruptLineCount).toBe(1);
      // What is left is a prefix of what was written, still in order, and the
      // partial line at the end is counted rather than guessed at.
      expect(cut.outputs.map((output) => output.sequence)).toEqual(
        cut.outputs.map((_, index) => index),
      );
      expect(cut.outputs.length).toBeGreaterThan(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
