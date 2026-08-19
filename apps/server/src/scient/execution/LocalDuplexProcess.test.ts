// @effect-diagnostics nodeBuiltinImport:off -- integration fixture probes its captured child PID.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DuplexProcessId } from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { DuplexProcess, layer } from "./LocalDuplexProcess.ts";
import { descendantFixture, processExists } from "./LocalProcessTestSupport.ts";

const Live = layer.pipe(Layer.provideMerge(NodeServices.layer));

const encoder = new TextEncoder();

/** Answers every line on stdout, comments on it on stderr, and stays alive. */
const echoFixture = [
  "process.stdin.setEncoding('utf8');",
  "let buffer = '';",
  "process.stdin.on('data', (chunk) => {",
  "  buffer += chunk;",
  "  for (;;) {",
  "    const index = buffer.indexOf('\\n');",
  "    if (index < 0) break;",
  "    const line = buffer.slice(0, index);",
  "    buffer = buffer.slice(index + 1);",
  "    process.stdout.write('out:' + line + '\\n');",
  "    process.stderr.write('err:' + line + '\\n');",
  "  }",
  "});",
  "setInterval(() => {}, 1000);",
].join("\n");

/** Echoes one message containing every possible byte, without text decoding. */
const binaryEchoFixture = [
  "const chunks = [];",
  "let byteLength = 0;",
  "process.stdin.on('data', (chunk) => {",
  "  chunks.push(chunk);",
  "  byteLength += chunk.byteLength;",
  "  if (byteLength < 256) return;",
  "  process.stdout.write(Buffer.concat(chunks, byteLength).subarray(0, 256));",
  "});",
  "setInterval(() => {}, 1000);",
].join("\n");

const startFixture = (processId: string, source: string) =>
  Effect.flatMap(DuplexProcess, (processes) =>
    processes.start({
      processId: DuplexProcessId.make(processId),
      executable: NodeProcess.execPath,
      args: ["-e", source],
      cwd: NodeProcess.cwd(),
      environment: {},
    }),
  );

const readLines = <E>(stream: Stream.Stream<Uint8Array, E>, count: number) =>
  stream.pipe(Stream.decodeText(), Stream.splitLines, Stream.take(count), Stream.runCollect);

describe("LocalDuplexProcess", () => {
  it.effect("delivers written input and keeps the two output streams apart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-echo-test", echoFixture);
        expect(Number.isSafeInteger(handle.pid)).toBe(true);
        expect(processExists(handle.pid)).toBe(true);

        // Two writes, because the peer must still be listening after the first.
        yield* handle.write(encoder.encode("alpha\n"));
        yield* handle.write(encoder.encode("beta\n"));

        expect(yield* readLines(handle.stdout, 2)).toEqual(["out:alpha", "out:beta"]);
        expect(yield* readLines(handle.stderr, 2)).toEqual(["err:alpha", "err:beta"]);
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("preserves every binary byte through stdin and stdout", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-binary-test", binaryEchoFixture);
        const payload = Uint8Array.from({ length: 256 }, (_, index) => index);

        yield* handle.write(payload);
        const echoed = yield* handle.stdout.pipe(
          Stream.flatMap((chunk) => Stream.fromIterable(chunk)),
          Stream.take(payload.byteLength),
          Stream.runCollect,
        );

        expect(echoed).toEqual([...payload]);
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("reports a write after process cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-write-after-cancel-test", echoFixture);

        yield* handle.cancelProcessTree;
        const error = yield* Effect.flip(handle.write(encoder.encode("too late\n")));

        expect(error.operation).toBe("write");
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("does not extend the host environment when extendEnv is false", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.flatMap(DuplexProcess, (processes) =>
          processes.start({
            processId: DuplexProcessId.make("duplex-extend-env-false"),
            executable: NodeProcess.execPath,
            args: ["-e", "process.stdout.write(process.env.PATH ? 'present' : 'absent')"],
            cwd: NodeProcess.cwd(),
            environment: {},
            extendEnv: false,
          }),
        );

        const line = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(line).toBe("absent");
        yield* handle.cancelProcessTree;
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("extends the host environment by default", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* Effect.flatMap(DuplexProcess, (processes) =>
          processes.start({
            processId: DuplexProcessId.make("duplex-extend-env-default"),
            executable: NodeProcess.execPath,
            args: ["-e", "process.stdout.write(process.env.PATH ? 'present' : 'absent')"],
            cwd: NodeProcess.cwd(),
            environment: {},
          }),
        );

        const line = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(line).toBe("present");
        yield* handle.cancelProcessTree;
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("cancels a spawned descendant with the owned process tree", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-process-tree-test", descendantFixture);
        const childPidLine = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const childPid = Number(childPidLine);
        expect(Number.isSafeInteger(childPid)).toBe(true);
        expect(processExists(childPid)).toBe(true);

        yield* handle.cancelProcessTree;

        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(Live)),
  );
});
