import {
  ComputeExecutionId,
  ComputeSessionGeneration,
  ComputeSessionId,
  INITIAL_COMPUTE_SESSION_GENERATION,
  type ComputeExecutionRecord,
  type ComputeOutput,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  computeExecutionStatusLabel,
  computeProjectedStaticImage,
  computeSourceFreshnessLabel,
  computeSourceLabel,
  computeSystemEventLabel,
  mergeComputeOutputs,
  selectComputeFigureFallback,
} from "./computeResultPresentation";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];
type ComputeSystemEvent = Extract<ComputeOutput, { readonly _tag: "system" }>["event"];

it("adapts a retained rich static image without losing its immutable identity", () => {
  expect(
    computeProjectedStaticImage({
      _tag: "representation",
      kind: "display-data",
      sequence: 4,
      observedAt: "2026-08-23T12:00:00.000Z",
      revisionSequence: 7,
      revisedAt: "2026-08-23T12:00:01.000Z",
      bundle: {
        representations: [
          { mediaType: "text/plain", data: { _tag: "text", text: "fallback" } },
          {
            mediaType: "image/png",
            data: { _tag: "resource", contentHash: "sha256:figure", byteLength: 128 },
          },
        ],
        metadataJson: null,
      },
      displayId: "display-1",
      executionCount: null,
    }),
  ).toMatchObject({
    _tag: "image",
    sequence: 4,
    mediaType: "image/png",
    contentHash: "sha256:figure",
    origin: { _tag: "runtime-display" },
  });
});

const documentSource = (
  overrides: Partial<Extract<ComputeExecutionSource, { _tag: "document" }>> = {},
): Extract<ComputeExecutionSource, { _tag: "document" }> => ({
  _tag: "document",
  origin: "file",
  path: "analysis.py",
  bufferState: "saved",
  revision: "sha256:revision",
  range: { startLine: 0, startColumn: 0, endLine: 20, endColumn: 0 },
  ...overrides,
});

const execution = (
  id: string,
  status: NonNullable<ComputeExecutionRecord["result"]>["status"] | null,
  imageCount = 0,
  overrides: Partial<ComputeExecutionRecord["request"]> = {},
): ComputeExecutionRecord => {
  const executionId = ComputeExecutionId.make(id);
  return {
    request: {
      executionId,
      sessionId: ComputeSessionId.make("session-1"),
      generation: INITIAL_COMPUTE_SESSION_GENERATION,
      code: "plot()",
      codeHash: `sha256:${id}`,
      source: documentSource(),
      submittedAt: `2026-08-21T09:00:0${id.at(-1) ?? "0"}.000Z`,
      environmentFingerprint: null,
      ...overrides,
    },
    result:
      status === null
        ? null
        : {
            executionId,
            status,
            outcome:
              status === "succeeded"
                ? "succeeded"
                : status === "failed"
                  ? "failed"
                  : status === "cancelled"
                    ? "cancelled"
                    : null,
            queuePosition: null,
            startedAt: "2026-08-21T09:00:00.000Z",
            finishedAt:
              status === "queued" ||
              status === "submitting" ||
              status === "running" ||
              status === "interrupting"
                ? null
                : "2026-08-21T09:00:01.000Z",
            diagnostics: [],
            outputCount: imageCount,
            imageCount,
            outputBytes: imageCount * 100,
            truncated: false,
            failureReason: status === "failed" ? "Failed" : null,
          },
  };
};

describe("compute result presentation", () => {
  it("shows live output even when the first durable read was empty", () => {
    const live: ReadonlyArray<ComputeOutput> = [
      {
        _tag: "stream",
        sequence: 2,
        observedAt: "2026-08-21T09:00:00.000Z",
        stream: "stdout",
        text: "finished\n",
      },
    ];

    expect(mergeComputeOutputs([], live)).toEqual(live);
  });

  it("merges durable history with later live output without duplicating figures", () => {
    const firstFigure = {
      _tag: "image",
      sequence: 3,
      observedAt: "2026-08-21T09:00:00.000Z",
      mediaType: "image/svg+xml",
      contentHash: `sha256:${"a".repeat(64)}`,
      byteLength: 12,
      width: 4,
      height: 3,
    } as const satisfies ComputeOutput;
    const secondFigure = {
      ...firstFigure,
      contentHash: `sha256:${"b".repeat(64)}`,
    } as const satisfies ComputeOutput;
    const persisted: ReadonlyArray<ComputeOutput> = [
      {
        _tag: "stream",
        sequence: 1,
        observedAt: "2026-08-21T08:59:59.000Z",
        stream: "stdout",
        text: "started\n",
      },
      firstFigure,
    ];

    expect(mergeComputeOutputs(persisted, [firstFigure, secondFigure])).toEqual([
      persisted[0],
      firstFigure,
      secondFigure,
    ]);
  });

  it("deduplicates identical display lifecycle facts without hiding real revisions", () => {
    const displayed = {
      _tag: "display-data",
      sequence: 4,
      observedAt: "2026-08-21T09:00:00.000Z",
      bundle: {
        representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "before" } }],
        metadataJson: null,
      },
      displayId: "progress",
    } as const satisfies ComputeOutput;
    const updated = {
      _tag: "display-update",
      sequence: 5,
      observedAt: "2026-08-21T09:00:01.000Z",
      bundle: {
        representations: [{ mediaType: "text/plain", data: { _tag: "text", text: "after" } }],
        metadataJson: null,
      },
      displayId: "progress",
    } as const satisfies ComputeOutput;

    expect(mergeComputeOutputs([displayed], [displayed, updated])).toEqual([displayed, updated]);
  });

  it("shows only useful file provenance in embedded results", () => {
    expect(computeSourceLabel(documentSource(), { includePath: false })).toBe("File");
    expect(
      computeSourceLabel(
        documentSource({
          origin: "selection",
          bufferState: "dirty",
          range: { startLine: 8, startColumn: 0, endLine: 11, endColumn: 5 },
        }),
        { includePath: false },
      ),
    ).toBe("Selection · lines 9–12 · unsaved");
  });

  it("adds the project path only when results are outside the file", () => {
    expect(
      computeSourceLabel(
        documentSource({
          origin: "cell",
          range: { startLine: 4, startColumn: 0, endLine: 4, endColumn: 12 },
        }),
        { includePath: true },
      ),
    ).toBe("analysis.py · Cell · line 5");
    expect(computeSourceLabel({ _tag: "console" }, { includePath: true })).toBe("Console");
  });

  it("shows compact source freshness without adding noise to dirty submissions", () => {
    expect(
      computeSourceFreshnessLabel(documentSource(), {
        revision: "sha256:new",
        pending: false,
      }),
    ).toBe("Source changed");
    expect(
      computeSourceFreshnessLabel(documentSource(), {
        revision: "sha256:revision",
        pending: true,
      }),
    ).toBe("Source changed");
    expect(
      computeSourceFreshnessLabel(documentSource({ bufferState: "dirty" }), {
        revision: "sha256:new",
        pending: true,
      }),
    ).toBeNull();
  });

  it("keeps the newest same-generation figure visible while an update settles or fails", () => {
    const previous = execution("execution-1", "succeeded", 2);
    const running = execution("execution-2", "running");
    const failed = execution("execution-3", "failed");

    expect(selectComputeFigureFallback([running, previous], running, false)).toEqual({
      execution: previous,
      reason: "updating",
    });
    expect(selectComputeFigureFallback([failed, previous], failed, false)).toEqual({
      execution: previous,
      reason: "latest-run-failed",
    });
  });

  it("never mixes figures into history or a newer successful no-figure result", () => {
    const previous = execution("execution-1", "succeeded", 1);
    const succeeded = execution("execution-2", "succeeded");
    const running = execution("execution-3", "running");
    const otherGeneration = execution("execution-0", "succeeded", 1, {
      generation: ComputeSessionGeneration.make(2),
    });

    expect(selectComputeFigureFallback([running, previous], previous, false)).toBeNull();
    expect(selectComputeFigureFallback([succeeded, previous], succeeded, false)).toBeNull();
    expect(selectComputeFigureFallback([running, previous], running, true)).toBeNull();
    expect(selectComputeFigureFallback([running, otherGeneration], running, false)).toBeNull();
  });

  it("never falls back to a same-file figure from another session", () => {
    const previousSessionFigure = execution("execution-1", "succeeded", 1, {
      sessionId: ComputeSessionId.make("session-2"),
    });
    const running = execution("execution-2", "running");

    expect(
      selectComputeFigureFallback([running, previousSessionFigure], running, false),
    ).toBeNull();
  });

  it("uses user-facing execution and system labels", () => {
    expect(computeExecutionStatusLabel(null)).toBe("Pending");
    expect(computeExecutionStatusLabel({ status: "lost", queuePosition: null })).toBe(
      "Session ended",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: null })).toBe("Queued");
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 0 })).toBe(
      "Queued · next",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 1 })).toBe(
      "Queued · next",
    );
    expect(computeExecutionStatusLabel({ status: "queued", queuePosition: 2 })).toBe(
      "Queued · 2 ahead",
    );

    const expectations: ReadonlyArray<readonly [ComputeSystemEvent, string]> = [
      ["session-started", "Session started"],
      ["session-restarted", "Session restarted"],
      ["execution-interrupted", "Execution interrupted"],
      ["session-lost", "Session ended unexpectedly"],
      ["output-truncated", "Some output was not retained"],
      ["input-unsupported", "Interactive input is not supported"],
      ["runtime-warning", "Runtime warning"],
    ];
    for (const [event, label] of expectations) {
      expect(computeSystemEventLabel(event)).toBe(label);
    }
  });
});
