import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * The bounded primitives every compute schema is built from.
 *
 * Internal to the package: `index.ts` does not re-export this module, because a
 * consumer that could name `Label` would be depending on the width of a field
 * rather than on the field. They live in one file so a live contract and a
 * durable record cannot disagree about how long an error message may be -- a
 * record that accepted more than the wire does would be unsendable, and a
 * record that accepted less would be unstorable.
 */
export const EntityId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
export const Slug = Schema.NonEmptyString.check(Schema.isMaxLength(64));
export const Label = Schema.String.check(Schema.isMaxLength(256));
export const ShortText = Schema.String.check(Schema.isMaxLength(4096));
export const RuntimeErrorText = Schema.String.check(Schema.isMaxLength(16 * 1024));
const utf8 = new TextEncoder();
export const MAXIMUM_STREAM_TEXT_BYTES = 1024 * 1024;
export const StreamText = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_STREAM_TEXT_BYTES),
  Schema.makeFilter((value: string) =>
    utf8.encode(value).byteLength <= MAXIMUM_STREAM_TEXT_BYTES
      ? true
      : `Expected at most ${MAXIMUM_STREAM_TEXT_BYTES} UTF-8 bytes.`,
  ),
);
export const ContentHash = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Pixels = Schema.Int.check(Schema.isGreaterThan(0));
export const ProcessId = Schema.Int.check(Schema.isGreaterThan(0));
export const ObservedAt = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) =>
    Option.isSome(DateTime.make(value)) ? true : "Expected an ISO-8601 instant.",
  ),
);
