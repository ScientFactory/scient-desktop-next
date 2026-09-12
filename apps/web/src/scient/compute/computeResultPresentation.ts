import {
  projectComputeOutputs,
  sameComputeRepresentationBundle,
  type ComputeExecutionRecord,
  type ComputeOutput,
  type ComputeProjectedOutput,
} from "@t3tools/contracts";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];
type ComputeExecutionStatus = NonNullable<ComputeExecutionRecord["result"]>["status"];
type ComputeSystemEvent = Extract<ComputeOutput, { readonly _tag: "system" }>["event"];
export const COMPUTE_NATIVE_FIGURE_MEDIA_TYPE = "application/vnd.mathworks.matlab.figure";
// Matches the retained representation-bundle limit; native files are never decoded here.
export const MAX_COMPUTE_NATIVE_FIGURE_BYTES = 8 * 1024 * 1024;

export type ComputeFigureResource = {
  readonly contentHash: Extract<ComputeOutput, { readonly _tag: "image" }>["contentHash"];
  readonly byteLength: number;
};

/** Local presentation metadata; the retained output contract stays unchanged. */
export type ComputeStaticImageOutput = Extract<ComputeOutput, { readonly _tag: "image" }> & {
  readonly displayId?: string;
  readonly nativeFigure?: ComputeFigureResource;
};

/** A standalone image update is itself a complete retained figure snapshot. */
export function projectComputeFigureOutputs(
  outputs: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeProjectedOutput> {
  const displays = new Set<string>();
  return projectComputeOutputs(
    outputs.map((output): ComputeOutput => {
      if (output._tag === "display-data" && output.displayId !== null)
        displays.add(output.displayId);
      if (
        output._tag === "display-update" &&
        !displays.has(output.displayId) &&
        output.bundle.representations.some(
          (item) =>
            (item.mediaType === "image/png" || item.mediaType === "image/svg+xml") &&
            item.data._tag === "resource",
        )
      ) {
        displays.add(output.displayId);
        return { ...output, _tag: "display-data" };
      }
      return output;
    }),
  );
}

/** Adapts one projected rich bundle into the existing producer-neutral image surface. */
export function computeProjectedStaticImage(
  output: Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>,
): ComputeStaticImageOutput | null {
  const native = output.bundle.representations.find(
    (item) => item.mediaType === COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
  );
  const nativeFigure =
    native?.data._tag === "resource" &&
    Number.isSafeInteger(native.data.byteLength) &&
    native.data.byteLength > 0 &&
    native.data.byteLength <= MAX_COMPUTE_NATIVE_FIGURE_BYTES
      ? native.data
      : null;
  for (const mediaType of ["image/svg+xml", "image/png"] as const) {
    const representation = output.bundle.representations.find(
      (candidate) => candidate.mediaType === mediaType && candidate.data._tag === "resource",
    );
    if (representation?.data._tag !== "resource") continue;
    return {
      _tag: "image",
      sequence: output.sequence,
      observedAt: output.observedAt,
      mediaType,
      contentHash: representation.data.contentHash,
      byteLength: representation.data.byteLength,
      width: null,
      height: null,
      origin: { _tag: "runtime-display" },
      ...(output.displayId === null ? {} : { displayId: output.displayId }),
      ...(nativeFigure === null ? {} : { nativeFigure }),
    };
  }
  return null;
}

function sameOutput(left: ComputeOutput, right: ComputeOutput): boolean {
  if (left.sequence !== right.sequence || left._tag !== right._tag) return false;
  switch (left._tag) {
    case "stream":
      return right._tag === "stream" && left.stream === right.stream && left.text === right.text;
    case "diagnostic":
      return (
        right._tag === "diagnostic" &&
        left.diagnostic.errorName === right.diagnostic.errorName &&
        left.diagnostic.message === right.diagnostic.message &&
        left.diagnostic.traceback.length === right.diagnostic.traceback.length &&
        left.diagnostic.traceback.every(
          (line, index) => line === right.diagnostic.traceback[index],
        ) &&
        left.diagnostic.frames.length === right.diagnostic.frames.length &&
        left.diagnostic.frames.every((frame, index) => {
          const candidate = right.diagnostic.frames[index];
          return (
            candidate !== undefined &&
            frame.relativePath === candidate.relativePath &&
            frame.line === candidate.line &&
            frame.column === candidate.column &&
            frame.functionName === candidate.functionName
          );
        })
      );
    case "image":
      return right._tag === "image" && left.contentHash === right.contentHash;
    case "system":
      return right._tag === "system" && left.event === right.event && left.detail === right.detail;
    case "display-data":
      return (
        right._tag === "display-data" &&
        left.displayId === right.displayId &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "execute-result":
      return (
        right._tag === "execute-result" &&
        left.executionCount === right.executionCount &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "display-update":
      return (
        right._tag === "display-update" &&
        left.displayId === right.displayId &&
        sameComputeRepresentationBundle(left.bundle, right.bundle)
      );
    case "clear-output":
      return right._tag === "clear-output" && left.wait === right.wait;
  }
}

/**
 * Reconciles a possibly stale durable read with newer bounded notifications.
 * Sequence groups preserve multiple figures emitted by one runtime event.
 */
export function mergeComputeOutputs(
  persisted: ReadonlyArray<ComputeOutput>,
  live: ReadonlyArray<ComputeOutput>,
): ReadonlyArray<ComputeOutput> {
  if (persisted.length === 0) return live;
  if (live.length === 0) return persisted;

  const groups = new Map<number, ComputeOutput[]>();
  for (const output of persisted) {
    const group = groups.get(output.sequence) ?? [];
    group.push(output);
    groups.set(output.sequence, group);
  }
  for (const output of live) {
    const group = groups.get(output.sequence) ?? [];
    if (!group.some((candidate) => sameOutput(candidate, output))) group.push(output);
    groups.set(output.sequence, group);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, outputs]) => outputs);
}

const SOURCE_ORIGIN_LABELS = {
  file: "File",
  selection: "Selection",
  cell: "Cell",
} as const satisfies Record<
  Extract<ComputeExecutionSource, { _tag: "document" }>["origin"],
  string
>;

const EXECUTION_STATUS_LABELS = {
  queued: "Queued",
  submitting: "Starting",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  interrupting: "Stopping",
  cancelled: "Cancelled",
  lost: "Session ended",
} as const satisfies Record<ComputeExecutionStatus, string>;

const SYSTEM_EVENT_LABELS = {
  "session-started": "Session started",
  "session-restarted": "Session restarted",
  "execution-interrupted": "Execution interrupted",
  "session-lost": "Session ended unexpectedly",
  "output-truncated": "Some output was not retained",
  "input-unsupported": "Interactive input is not supported",
  "runtime-warning": "Runtime warning",
} as const satisfies Record<ComputeSystemEvent, string>;

export function computeSourceLabel(
  source: ComputeExecutionSource,
  options: { readonly includePath: boolean },
): string {
  if (source._tag === "console") return "Console";

  const range =
    source.origin === "file" || source.range === null
      ? null
      : source.range.startLine === source.range.endLine
        ? `line ${source.range.startLine + 1}`
        : `lines ${source.range.startLine + 1}–${source.range.endLine + 1}`;
  return [
    ...(options.includePath ? [source.path] : []),
    SOURCE_ORIGIN_LABELS[source.origin],
    range,
    source.bufferState === "dirty" ? "unsaved" : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
}

export function computeSourceFreshnessLabel(
  source: ComputeExecutionSource,
  current: { readonly revision: string; readonly pending: boolean } | null,
): "Source changed" | null {
  if (source._tag !== "document" || current === null || source.bufferState === "dirty") return null;
  return current.pending || source.revision !== current.revision ? "Source changed" : null;
}

export interface ComputeFigureFallback {
  readonly execution: ComputeExecutionRecord;
  readonly reason: "updating" | "latest-run-failed";
}

function fallbackReason(
  status: ComputeExecutionStatus | undefined,
): ComputeFigureFallback["reason"] | null {
  switch (status) {
    case undefined:
    case "queued":
    case "submitting":
    case "running":
    case "interrupting":
      return "updating";
    case "failed":
    case "cancelled":
    case "lost":
      return "latest-run-failed";
    case "succeeded":
      return null;
  }
}

/**
 * Keeps the last successful figure visible while the newest run is settling or
 * has failed. History remains exact: fallback is only valid for the newest run
 * of the same document and session generation, and a newer successful run with
 * no figures clears it.
 */
export function selectComputeFigureFallback(
  executions: ReadonlyArray<ComputeExecutionRecord>,
  selected: ComputeExecutionRecord | null,
  selectedHasObservedImage: boolean,
): ComputeFigureFallback | null {
  if (selected === null || executions[0]?.request.executionId !== selected.request.executionId) {
    return null;
  }
  const selectedSource = selected.request.source;
  if (
    selectedSource._tag !== "document" ||
    selectedHasObservedImage ||
    (selected.result?.imageCount ?? 0) > 0
  ) {
    return null;
  }

  const reason = fallbackReason(selected.result?.status);
  if (reason === null) return null;

  const execution = executions.slice(1).find((candidate) => {
    const source = candidate.request.source;
    return (
      source._tag === "document" &&
      source.path === selectedSource.path &&
      candidate.request.sessionId === selected.request.sessionId &&
      candidate.request.generation === selected.request.generation &&
      candidate.result?.status === "succeeded" &&
      candidate.result.imageCount > 0
    );
  });
  return execution === undefined ? null : { execution, reason };
}

export function computeExecutionStatusLabel(
  result: Pick<NonNullable<ComputeExecutionRecord["result"]>, "status" | "queuePosition"> | null,
): string {
  if (result === null) return "Pending";
  if (result.status !== "queued" || result.queuePosition === null) {
    return EXECUTION_STATUS_LABELS[result.status];
  }
  return result.queuePosition <= 1 ? "Queued · next" : `Queued · ${result.queuePosition} ahead`;
}

export function computeSystemEventLabel(event: ComputeSystemEvent): string {
  return SYSTEM_EVENT_LABELS[event];
}
