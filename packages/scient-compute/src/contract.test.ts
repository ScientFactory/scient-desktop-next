import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ComputeOutput } from "./contract.ts";

const decodeOutput = Schema.decodeUnknownSync(ComputeOutput);

describe("compute contract", () => {
  it("accepts observed timestamps only when they are ISO-8601 instants", () => {
    expect(
      decodeOutput({
        _tag: "stream",
        sequence: 0,
        observedAt: "2026-08-19T00:00:00.000Z",
        stream: "stdout",
        text: "ready\n",
      }).observedAt,
    ).toBe("2026-08-19T00:00:00.000Z");

    expect(() =>
      decodeOutput({
        _tag: "stream",
        sequence: 0,
        observedAt: "eventually",
        stream: "stdout",
        text: "ready\n",
      }),
    ).toThrow();
  });
});
