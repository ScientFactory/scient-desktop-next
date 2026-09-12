import { ComputeProjectId, ComputeSessionId } from "@scientfactory/compute";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { makeComputeSessionNotifications } from "./ComputeSessionNotifications.ts";

// Identical portable payload IDs can belong to different server-owned partitions.
const event = (value: string) => (eventSequence: number) => ({
  _tag: "execution-output" as const,
  eventSequence,
  projectId: ComputeProjectId.make("portable-project"),
  sessionId: ComputeSessionId.make("portable-session"),
  executionId: null,
  outputs: [
    {
      _tag: "stream" as const,
      sequence: 0,
      observedAt: "2026-08-31T00:00:00.000Z",
      stream: "stdout" as const,
      text: value,
    },
  ],
});

describe("Compute session notifications", () => {
  it.effect("isolates owner keys even when portable IDs are identical", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* makeComputeSessionNotifications;
        const a = yield* notifications.subscribe("binding-a");
        yield* notifications.subscribe("binding-b").pipe(Effect.asVoid);
        yield* notifications.publish("binding-a", event("a-terminal"));
        for (let index = 0; index < 2_000; index++) {
          yield* notifications.publish("binding-b", event("b-flood"));
        }
        yield* notifications.publish("binding-a", event("a-next"));
        const received = yield* a.pipe(Stream.take(2), Stream.runCollect);
        expect(received).toEqual([event("a-terminal")(0), event("a-next")(1)]);
      }),
    ),
  );

  it.effect("gives late subscribers independent contiguous zero-based cursors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* makeComputeSessionNotifications;
        const early = yield* notifications.subscribe("owner");
        yield* notifications.publish("owner", event("first"));
        const late = yield* notifications.subscribe("owner");
        yield* notifications.publish("owner", event("second"));
        yield* notifications.publish("owner", event("third"));
        expect(yield* early.pipe(Stream.take(3), Stream.runCollect)).toEqual([
          event("first")(0),
          event("second")(1),
          event("third")(2),
        ]);
        expect(yield* late.pipe(Stream.take(2), Stream.runCollect)).toEqual([
          event("second")(0),
          event("third")(1),
        ]);
      }),
    ),
  );

  it.effect(
    "bounds a paused subscriber without blocking an active reader or reordering concurrent publication",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const notifications = yield* makeComputeSessionNotifications;
          const paused = yield* notifications.subscribe("owner");
          const active = yield* notifications.subscribe("owner");
          const count = 2_048;
          const delivered: Array<{ readonly eventSequence: number }> = [];
          for (let offset = 0; offset < count; offset += 16) {
            yield* Effect.forEach(
              Array.from({ length: 16 }, (_, index) => offset + index),
              (index) => notifications.publish("owner", event(String(index))),
              { concurrency: 16, discard: true },
            );
            delivered.push(...(yield* active.pipe(Stream.take(16), Stream.runCollect)));
          }
          expect(delivered.map((value) => value.eventSequence)).toEqual(
            Array.from({ length: count }, (_, index) => index),
          );
          const retained = yield* paused.pipe(Stream.take(512), Stream.runCollect);
          expect(retained).toEqual(delivered.slice(-512));
          expect(retained[0]?.eventSequence).toBe(count - 512);
          expect(retained.at(-1)?.eventSequence).toBe(count - 1);
        }),
      ),
  );

  it.effect("closing one subscriber preserves another; the last close releases its channel", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const notifications = yield* makeComputeSessionNotifications;
        const firstScope = yield* Scope.make();
        const secondScope = yield* Scope.make();
        const first = yield* notifications
          .subscribe("owner")
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        const second = yield* notifications
          .subscribe("owner")
          .pipe(Effect.provideService(Scope.Scope, secondScope));
        const waiting = yield* first.pipe(Stream.runHead, Effect.forkChild);
        yield* Scope.close(firstScope, Exit.void);
        const firstExit = yield* Fiber.await(waiting);
        expect(firstExit).toEqual(Exit.succeed(Option.none()));
        yield* notifications.publish("owner", event("still-live"));
        expect(yield* second.pipe(Stream.take(1), Stream.runCollect)).toEqual([
          event("still-live")(0),
        ]);
        yield* Scope.close(secondScope, Exit.void);
        // No subscribers means no channel/counter allocation for publications.
        let allocated = false;
        yield* notifications.publish("owner", (sequence) => {
          allocated = true;
          return event("unobserved")(sequence);
        });
        expect(allocated).toBe(false);
        const fresh = yield* notifications.subscribe("owner");
        yield* notifications.publish("owner", event("fresh"));
        expect(yield* fresh.pipe(Stream.take(1), Stream.runCollect)).toEqual([event("fresh")(0)]);
      }),
    ),
  );

  it.effect("service scope shutdown releases suspended subscribers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const serviceScope = yield* Scope.make();
        const notifications = yield* makeComputeSessionNotifications.pipe(
          Effect.provideService(Scope.Scope, serviceScope),
        );
        const changes = yield* notifications.subscribe("owner");
        const reader = yield* changes.pipe(Stream.runHead, Effect.forkChild);
        yield* Scope.close(serviceScope, Exit.void);
        const readerExit = yield* Fiber.await(reader);
        expect(readerExit).toEqual(Exit.succeed(Option.none()));
      }),
    ),
  );
});
