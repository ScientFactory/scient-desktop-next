import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "node:crypto";
import {
  ComputeExecutionRequestRecord,
  ComputeExecutionResultRecord,
  ComputeOutput,
  ComputeSessionRecord,
  type ComputeExecutionId,
} from "@scientfactory/compute";
import { WS_METHODS } from "@t3tools/contracts";
import { assert, type Vitest } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import type { ScientRpcServerTestHarness } from "../../server.test.ts";
import { LocalComputeStore, layer as localComputeStoreLayer } from "./LocalComputeStore.ts";

const OBSERVED_AT = "2026-08-20T09:00:00.000Z";

const decodeSession = Schema.decodeUnknownSync(ComputeSessionRecord);
const decodeRequest = Schema.decodeUnknownSync(ComputeExecutionRequestRecord);
const decodeResult = Schema.decodeUnknownSync(ComputeExecutionResultRecord);
const decodeOutput = Schema.decodeUnknownSync(ComputeOutput);

const contentHashOf = (bytes: Uint8Array): string =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;

/** A distinct figure per index, so a mixed-up response is a wrong body. */
const figureBytes = (index: number): Uint8Array =>
  new Uint8Array([
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
    ...Array.from({ length: index + 1 }, (_, offset) => (index * 31 + offset) % 251),
  ]);

const sessionRecord = decodeSession({
  sessionId: "session-figures",
  projectId: "project-figures",
  label: "Figures",
  languageId: "python",
  transportKind: "jupyter-bridge",
  workingDirectory: "/projects/figures",
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

const requestRecord = (index: number) =>
  decodeRequest({
    executionId: `execution-${String(index)}`,
    sessionId: sessionRecord.sessionId,
    generation: 1,
    code: "plot()",
    codeHash: `sha256:code-${String(index)}`,
    source: { _tag: "console" },
    submittedAt: OBSERVED_AT,
    environmentFingerprint: null,
  });

const resultRecord = (executionId: string, outputCount: number, outputBytes: number) =>
  decodeResult({
    executionId,
    status: "succeeded",
    outcome: "succeeded",
    queuePosition: null,
    startedAt: OBSERVED_AT,
    finishedAt: "2026-08-20T09:00:02.000Z",
    diagnostics: [],
    outputCount,
    outputBytes,
    truncated: false,
    failureReason: null,
  });

type SeededFigure = {
  readonly executionId: ComputeExecutionId;
  readonly contentHash: string;
  readonly bytes: Uint8Array;
};

/**
 * A store over the same state directory the server under test will read.
 *
 * The asset path resolves an image from the transcript on disk, so a test can
 * seed one and then ask for it over the wire without an interpreter: the
 * transcript is the only thing that decides what may be served, and writing it
 * through the store's own API is what makes the seeded history a real one.
 */
const withComputeStore = <A, E>(
  baseDir: string,
  body: Effect.Effect<A, E, LocalComputeStore | FileSystem.FileSystem>,
) =>
  Effect.scoped(
    body.pipe(
      Effect.provide(
        localComputeStoreLayer.pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir))),
      ),
    ),
  );

/** Writes finished executions, each with figures the transcript accounts for. */
const seedFigures = (options: {
  readonly baseDir: string;
  readonly executions: number;
  readonly figuresPerExecution: number;
}) =>
  withComputeStore(
    options.baseDir,
    Effect.gen(function* () {
      const store = yield* LocalComputeStore;
      yield* store.writeSession(sessionRecord);
      const figures: Array<SeededFigure> = [];
      for (let index = 0; index < options.executions; index += 1) {
        const request = requestRecord(index);
        yield* store.writeExecutionRequest(sessionRecord.projectId, request);
        const seeded = Array.from({ length: options.figuresPerExecution }, (_, offset) => {
          const bytes = figureBytes(index * options.figuresPerExecution + offset);
          return { executionId: request.executionId, contentHash: contentHashOf(bytes), bytes };
        });
        yield* store.appendOutputs({
          projectId: sessionRecord.projectId,
          sessionId: sessionRecord.sessionId,
          executionId: request.executionId,
          outputs: seeded.map((figure, offset) =>
            decodeOutput({
              _tag: "image",
              sequence: offset,
              observedAt: OBSERVED_AT,
              mediaType: "image/png",
              contentHash: figure.contentHash,
              byteLength: figure.bytes.byteLength,
              width: 4,
              height: 3,
            }),
          ),
        });
        for (const figure of seeded) {
          yield* store.writeOutputImage({
            projectId: sessionRecord.projectId,
            sessionId: sessionRecord.sessionId,
            executionId: request.executionId,
            contentHash: figure.contentHash,
            mediaType: "image/png",
            bytes: figure.bytes,
          });
        }
        yield* store.writeExecutionResult(
          sessionRecord.projectId,
          sessionRecord.sessionId,
          resultRecord(
            request.executionId,
            seeded.length,
            seeded.reduce((total, figure) => total + figure.bytes.byteLength, 0),
          ),
        );
        figures.push(...seeded);
      }
      return figures;
    }),
  );

const outputRef = (figure: SeededFigure) => ({
  projectId: sessionRecord.projectId,
  sessionId: sessionRecord.sessionId,
  executionId: figure.executionId,
  contentHash: figure.contentHash,
});

const outputResource = (figure: SeededFigure) =>
  ({ _tag: "compute-output", ...outputRef(figure) }) as const;

// Registered by server.test.ts so these cases exercise the same T3 server seam.
export const registerComputeRpcTests = (
  it: Vitest.MethodsNonLive<NodeServices.NodeServices>,
  harness: ScientRpcServerTestHarness,
): void => {
  const { buildAppUnderTest, fetchEffect, getHttpServerUrl, getWsServerUrl, withWsRpcClient } =
    harness;

  it.effect("serves a figure a compute session produced and refuses one it never did", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-asset-rpc-" });
      const figures = yield* seedFigures({ baseDir, executions: 1, figuresPerExecution: 1 });
      const figure = figures[0]!;

      yield* buildAppUnderTest({ config: { baseDir } });
      const wsUrl = yield* getWsServerUrl("/ws");
      const issued = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const asset = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: outputResource(figure),
            });
            // Bytes that exist nowhere, under a hash the transcript never
            // mentions. A signed URL for this would be a way to name a file.
            const unknown = yield* client[WS_METHODS.assetsCreateUrl]({
              resource: {
                ...outputResource(figure),
                contentHash: contentHashOf(new Uint8Array([1, 2, 3])),
              },
            }).pipe(Effect.result);
            return { asset, unknown };
          }),
        ),
      );

      const response = yield* fetchEffect(yield* getHttpServerUrl(issued.asset.relativeUrl));
      assert.equal(response.status, 200);
      assert.equal(response.headers["content-type"], "image/png");
      assert.deepEqual(new Uint8Array(yield* response.arrayBuffer), figure.bytes);
      assert.equal(issued.unknown._tag, "Failure");
      if (issued.unknown._tag === "Failure") {
        assert.equal(issued.unknown.failure._tag, "AssetComputeOutputNotFoundError");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("keeps a burst of figures apart and stops serving one whose bytes changed", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-compute-asset-burst-" });
      // Several executions rather than one: the same content-addressed name in a
      // different execution's directory is the mix-up a single execution cannot
      // catch, and twenty at once is what a transcript scrolling into view does.
      const figures = yield* seedFigures({ baseDir, executions: 4, figuresPerExecution: 5 });

      yield* buildAppUnderTest({ config: { baseDir } });
      const wsUrl = yield* getWsServerUrl("/ws");
      const assets = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.all(
            figures.map((figure) =>
              client[WS_METHODS.assetsCreateUrl]({ resource: outputResource(figure) }),
            ),
            { concurrency: "unbounded" },
          ),
        ),
      );
      const served = yield* Effect.all(
        assets.map((asset) =>
          Effect.gen(function* () {
            const response = yield* fetchEffect(yield* getHttpServerUrl(asset.relativeUrl));
            return {
              status: response.status,
              bytes: new Uint8Array(yield* response.arrayBuffer),
            };
          }),
        ),
        { concurrency: "unbounded" },
      );

      // Every request got its own figure and nobody else's.
      assert.deepEqual(
        served.map((response) => response.status),
        figures.map(() => 200),
      );
      assert.deepEqual(
        served.map((response) => response.bytes),
        figures.map((figure) => figure.bytes),
      );

      // One figure's bytes are replaced under an already-signed URL. The path
      // comes from the store rather than from this test, because where a figure
      // lives is the store's business and not part of what is being proven.
      const tampered = figures[7]!;
      const resolved = yield* withComputeStore(
        baseDir,
        Effect.gen(function* () {
          const store = yield* LocalComputeStore;
          return yield* store.resolveOutputImage(outputRef(tampered));
        }),
      );
      assert.isNotNull(resolved);
      yield* fs.writeFile(resolved!.path, new Uint8Array([137, 80, 78, 71, 0]));

      const afterChange = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.assetsCreateUrl]({ resource: outputResource(tampered) }).pipe(
            Effect.result,
          ),
        ),
      );
      const [tamperedResponse, neighbourResponse] = yield* Effect.all([
        fetchEffect(yield* getHttpServerUrl(assets[7]!.relativeUrl)),
        fetchEffect(yield* getHttpServerUrl(assets[8]!.relativeUrl)),
      ]);

      // The signed URL pinned a revision, so it stops serving rather than
      // serving something else -- and a new one cannot be had at all, because
      // the bytes no longer hash to the identity the transcript recorded.
      assert.equal(tamperedResponse.status, 409);
      assert.equal(afterChange._tag, "Failure");
      if (afterChange._tag === "Failure") {
        assert.equal(afterChange.failure._tag, "AssetComputeOutputNotFoundError");
      }
      // Nothing else on that socket or in that session was affected.
      assert.equal(neighbourResponse.status, 200);
      assert.deepEqual(new Uint8Array(yield* neighbourResponse.arrayBuffer), figures[8]!.bytes);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );
};
