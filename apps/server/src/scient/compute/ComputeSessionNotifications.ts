import type { ComputeSessionStreamEvent } from "@scientfactory/compute";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

type LiveEvent = Exclude<ComputeSessionStreamEvent, { readonly _tag: "session-snapshot" }>;

interface Channel {
  readonly events: PubSub.PubSub<LiveEvent>;
  nextSequence: number;
  subscribers: number;
}

/**
 * Bounded Compute notifications, partitioned by the coordinator's owner key.
 * Channels exist only while subscribed; durable reads remain the authority.
 */
export const makeComputeSessionNotifications = Effect.gen(function* () {
  const channels = new Map<string, Channel>();
  const mutex = yield* Semaphore.make(1);

  const publish = Effect.fn("ComputeSessionNotifications.publish")(function* (
    ownerKey: string,
    event: (sequence: number) => LiveEvent,
  ) {
    yield* mutex.withPermits(1)(
      Effect.gen(function* () {
        const channel = channels.get(ownerKey);
        if (channel === undefined) return;
        // Sequence allocation and publication stay ordered even across sessions.
        // Sliding never waits for a client, including one that stops reading.
        yield* PubSub.publish(channel.events, event(channel.nextSequence++));
      }),
    );
  });

  const subscribe = Effect.fn("ComputeSessionNotifications.subscribe")(function* (
    ownerKey: string,
  ) {
    const { subscription, boundary } = yield* Effect.acquireRelease(
      mutex.withPermits(1)(
        Effect.gen(function* () {
          let channel = channels.get(ownerKey);
          if (channel === undefined) {
            channel = {
              events: yield* PubSub.sliding<LiveEvent>(512),
              nextSequence: 0,
              subscribers: 0,
            };
            channels.set(ownerKey, channel);
          }
          const subscription = yield* PubSub.subscribe(channel.events);
          channel.subscribers++;
          return { channel, subscription, boundary: channel.nextSequence };
        }),
      ),
      ({ channel }) =>
        mutex.withPermits(1)(
          Effect.gen(function* () {
            channel.subscribers--;
            if (channel.subscribers !== 0) return;
            channels.delete(ownerKey);
            yield* PubSub.shutdown(channel.events);
          }),
        ),
    );
    return Stream.fromSubscription(subscription).pipe(
      // Relative cursors let an empty initial snapshot detect loss too: its
      // first live event must be zero, not whichever event survived overflow.
      Stream.map((event) => ({ ...event, eventSequence: event.eventSequence - boundary })),
    );
  });

  yield* Effect.addFinalizer(() =>
    mutex.withPermits(1)(
      Effect.gen(function* () {
        yield* Effect.forEach(channels.values(), (channel) => PubSub.shutdown(channel.events));
        channels.clear();
      }),
    ),
  );

  return { publish, subscribe };
});
