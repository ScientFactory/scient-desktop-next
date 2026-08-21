import type {
  ComputeExecutionId,
  ComputeExecutionRecord,
  ComputeOutput,
  ComputeSessionRecord,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { CircleAlert, Image as ImageIcon, Info, LoaderCircle, RotateCcw } from "lucide-react";

import { useAssetUrlState } from "~/assets/assetUrls";
import { Button } from "~/components/ui/button";
import { useRightPanelStore } from "~/rightPanelStore";
import {
  StaticArtifactFileActionsMenu,
  StaticArtifactPresentationMenu,
} from "~/scient/artifacts/StaticArtifactMenus";

import {
  computeFigurePresentation,
  type ComputeFigurePresentation,
} from "./computeFigurePresentation";
import { computeSystemEventLabel } from "./computeResultPresentation";

type ComputeExecutionSource = ComputeExecutionRecord["request"]["source"];

function outputKey(output: ComputeOutput, index: number): string {
  return `${output.sequence}:${output._tag}:${index}`;
}

function ComputeFigure(props: {
  readonly presentation: ComputeFigurePresentation;
  readonly environmentId: EnvironmentId;
  readonly dimensions: string;
  readonly threadRef: ScopedThreadRef;
}) {
  const asset = useAssetUrlState(props.environmentId, props.presentation.inline.resource);

  return (
    <figure className="overflow-hidden rounded-md border border-border/70 bg-card">
      <StaticArtifactPresentationMenu
        artifact={props.presentation.viewer}
        disabled={asset._tag !== "Success"}
        threadRef={props.threadRef}
        triggerClassName="flex min-h-44 w-full cursor-pointer items-center justify-center bg-white p-3 outline-none transition hover:bg-muted/20 focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        {asset._tag === "Success" ? (
          <img
            src={asset.url}
            alt={props.presentation.inline.label}
            loading="lazy"
            className="max-h-[min(60vh,42rem)] max-w-full object-contain"
          />
        ) : asset._tag === "Loading" ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Loading figure…
          </span>
        ) : (
          <span className="flex items-center gap-2 text-xs text-destructive">
            <ImageIcon className="size-4" /> Figure preview unavailable
          </span>
        )}
      </StaticArtifactPresentationMenu>
      <figcaption className="flex min-h-9 items-center gap-2 border-t border-border/60 px-3">
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {props.presentation.inline.label}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">{props.dimensions}</span>
        {asset._tag === "Failure" ? (
          <Button size="icon-xs" variant="ghost" onClick={asset.refresh} aria-label="Retry figure">
            <RotateCcw />
          </Button>
        ) : null}
        <StaticArtifactFileActionsMenu
          assetUrl={asset._tag === "Success" ? asset.url : null}
          fileName={props.presentation.inline.fileName}
          threadRef={props.threadRef}
        />
      </figcaption>
    </figure>
  );
}

type DiagnosticFrame = Extract<
  ComputeOutput,
  { readonly _tag: "diagnostic" }
>["diagnostic"]["frames"][number];

function ComputeDiagnosticFrames(props: {
  readonly frames: ReadonlyArray<DiagnosticFrame>;
  readonly threadRef: ScopedThreadRef;
}) {
  if (props.frames.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {props.frames.slice(-6).map((frame) => (
        <button
          key={`${frame.relativePath}:${String(frame.line)}:${String(frame.column)}:${frame.functionName ?? ""}`}
          type="button"
          className="cursor-pointer rounded-[4px] bg-background/70 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          onClick={() =>
            useRightPanelStore
              .getState()
              .openFile(props.threadRef, frame.relativePath, frame.line ?? undefined)
          }
        >
          {frame.relativePath}
          {frame.line === null ? "" : `:${String(frame.line)}`}
          {frame.functionName === null ? "" : ` · ${frame.functionName}`}
        </button>
      ))}
    </div>
  );
}

export function ComputeOutputView(props: {
  readonly allowFigureFollowing?: boolean;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly session: ComputeSessionRecord;
  readonly executionId: ComputeExecutionId | null;
  readonly outputs: ReadonlyArray<ComputeOutput>;
  readonly emptyLabel?: string;
  readonly corruptLineCount?: number;
  readonly clipped?: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly source?: ComputeExecutionSource | null;
}) {
  if (props.outputs.length === 0 && !props.corruptLineCount && !props.clipped) {
    return <p className="text-xs text-muted-foreground">{props.emptyLabel ?? "No output."}</p>;
  }

  let imageOrdinal = 0;
  let runtimeDisplayOrdinal = 0;
  return (
    <div className="space-y-2">
      {props.clipped ? (
        <p className="text-[11px] text-warning">
          Earlier live output is hidden. The complete result remains available in run history.
        </p>
      ) : null}
      {props.corruptLineCount ? (
        <p className="text-[11px] text-destructive">
          Part of this result could not be read ({props.corruptLineCount} line
          {props.corruptLineCount === 1 ? "" : "s"}).
        </p>
      ) : null}
      {props.outputs.map((output, index) => {
        switch (output._tag) {
          case "stream":
            return (
              <pre
                key={outputKey(output, index)}
                className={
                  output.stream === "stderr"
                    ? "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive"
                    : "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
                }
              >
                {output.text}
              </pre>
            );
          case "diagnostic":
            return (
              <div
                key={outputKey(output, index)}
                className="rounded-md border border-destructive/25 bg-destructive/5 p-2 text-xs"
              >
                <div className="flex items-start gap-2">
                  <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="font-medium text-destructive">
                      {output.diagnostic.errorName}: {output.diagnostic.message}
                    </p>
                    <ComputeDiagnosticFrames
                      frames={output.diagnostic.frames}
                      threadRef={props.threadRef}
                    />
                    {output.diagnostic.traceback.length > 0 ? (
                      <details className="mt-1 text-muted-foreground">
                        <summary className="cursor-pointer">Traceback</summary>
                        <pre className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px]">
                          {output.diagnostic.traceback.join("\n")}
                        </pre>
                      </details>
                    ) : null}
                  </div>
                </div>
              </div>
            );
          case "image": {
            imageOrdinal += 1;
            if (output.origin?._tag === "runtime-display") runtimeDisplayOrdinal += 1;
            const presentation = computeFigurePresentation({
              allowFollowing: props.allowFigureFollowing ?? false,
              cwd: props.cwd,
              session: props.session,
              executionId: props.executionId,
              output,
              displayOrdinal: imageOrdinal,
              runtimeDisplayOrdinal,
              source: props.source ?? null,
            });
            return (
              <ComputeFigure
                key={outputKey(output, index)}
                presentation={presentation}
                environmentId={props.environmentId}
                dimensions={
                  output.width && output.height
                    ? `${output.width} × ${output.height}`
                    : output.mediaType === "image/svg+xml"
                      ? "SVG"
                      : "PNG"
                }
                threadRef={props.threadRef}
              />
            );
          }
          case "system":
            return (
              <div
                key={outputKey(output, index)}
                className="flex items-start gap-2 text-[11px] text-muted-foreground"
              >
                <Info className="mt-0.5 size-3 shrink-0" />
                <span>
                  {computeSystemEventLabel(output.event)}
                  {output.detail ? ` · ${output.detail}` : ""}
                </span>
              </div>
            );
        }
      })}
    </div>
  );
}
