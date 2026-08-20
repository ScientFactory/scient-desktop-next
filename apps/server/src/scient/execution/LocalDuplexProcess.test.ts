// @effect-diagnostics nodeBuiltinImport:off -- integration fixture probes its captured child PID.
import * as NodeProcess from "node:process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DuplexProcessId } from "@scientfactory/execution";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
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

/**
 * Writes a bounded burst of lines ending in a marker, then exits at once.
 *
 * The burst fits in the operating-system pipe buffer, so the process is gone
 * before a consumer reads anything: the marker proves the tail of that
 * buffered output still reaches the consumer after the exit is observed.
 */
const burstThenExitFixture = [
  "const lines = [];",
  "for (let index = 0; index < 2000; index += 1) lines.push('line:' + index);",
  "lines.push('done');",
  "process.stdout.write(lines.join('\\n') + '\\n');",
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

  it.effect("delivers output buffered before the process exited", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-burst-then-exit-test", burstThenExitFixture);

        // Observe the exit first, so the stream is only read once the writer is
        // provably gone and every byte is already sitting in the pipe.
        expect(yield* handle.exitCode).toBe(0);

        const lines = yield* handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runCollect,
        );

        expect(lines.length).toBe(2001);
        expect(lines[0]).toBe("line:0");
        expect(lines[2000]).toBe("done");
      }),
    ).pipe(Effect.provide(Live)),
  );

  it.effect("treats an already-stopped process tree as cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* startFixture("duplex-cancel-after-exit-test", "");
        expect(yield* handle.exitCode).toBe(0);

        // Cancelling a tree that is already gone is the expected outcome of a
        // scope closing after a peer shut itself down, and it stays repeatable.
        yield* handle.cancelProcessTree;
        yield* handle.cancelProcessTree;
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

        // `cancelProcessTree` waits for the direct child; the descendant is
        // reaped by init a moment later, so poll rather than sample once.
        yield* Effect.retry(
          Effect.suspend(() =>
            processExists(childPid) ? Effect.fail("descendant still running") : Effect.void,
          ),
          { times: 50, schedule: Schedule.spaced("20 millis") },
        );
        expect(processExists(childPid)).toBe(false);
      }),
    ).pipe(Effect.provide(Live)),
  );
});
