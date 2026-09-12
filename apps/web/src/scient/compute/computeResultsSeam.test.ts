// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const panelSource = NodeFS.readFileSync(NodePath.join(here, "ComputePanel.tsx"), "utf8");
const outputSource = NodeFS.readFileSync(NodePath.join(here, "ComputeOutputView.tsx"), "utf8");
const followerSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeFigureFollower.tsx"),
  "utf8",
);
const artifactPreviewSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/ScientArtifactPreview.tsx"),
  "utf8",
);
const artifactViewerActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/staticArtifactViewerActions.ts"),
  "utf8",
);
const artifactMenusSource = NodeFS.readFileSync(
  NodePath.join(here, "../artifacts/StaticArtifactMenus.tsx"),
  "utf8",
);
const imageActionButtonsSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/preview/StaticImageActionButtons.tsx"),
  "utf8",
);
const pythonActionsSource = NodeFS.readFileSync(
  NodePath.join(here, "ComputeFileActions.tsx"),
  "utf8",
);
const pythonSurfaceSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientComputeFileSurface.tsx"),
  "utf8",
);
const settingsSource = NodeFS.readFileSync(
  NodePath.join(here, "ScientificComputingSettings.tsx"),
  "utf8",
);

describe("compute result surface seam", () => {
  it("keys standalone controls by their owner and preserves producing result generations", () => {
    const chat = NodeFS.readFileSync(NodePath.join(here, "../../components/ChatView.tsx"), "utf8");
    expect(chat).toContain(
      "key={`${activeThreadRef.environmentId}:${activeThreadRef.threadId}:${renderedRightPanelSurface.id}`}",
    );
    expect(panelSource).toContain("executionGeneration={props.execution.request.generation}");
    expect(panelSource).toContain(
      "executionGeneration={props.figureFallback.execution.request.generation}",
    );
    const actions = panelSource.slice(
      panelSource.indexOf('aria-label="Session actions"'),
      panelSource.indexOf('aria-label="Session actions"') + 400,
    );
    expect(actions).not.toContain("operation !== null");
    expect(actions).toContain('operation === "stop"');
  });
  it("keeps editing in the file surface and results focused on outputs", () => {
    const resultSource = `${panelSource}\n${outputSource}`;
    expect(resultSource).not.toContain("Submitted code");
    expect(resultSource).not.toContain("Code that ran");
    expect(resultSource).not.toContain("Run code in this session");
    expect(resultSource).not.toContain("<textarea");
  });

  it("captures confirmation targets and keeps compact controls able to wrap", () => {
    expect(panelSource).toContain('kind: "stop"');
    expect(panelSource).toContain("anchorRect:");
    expect(panelSource).toContain("x: bounds.right");
    expect(panelSource).toContain("width: 0");
    expect(panelSource).toContain("runSessionCommand(confirmation.kind, confirmation.session)");
    expect(panelSource).toContain('role="alertdialog"');
    expect(panelSource).toContain('className="w-72 max-w-[calc(100vw-1rem)]"');
    expect(panelSource).toContain('align="center"');
    expect(panelSource).toContain('side="left"');
    expect(panelSource).not.toContain("<AlertDialog");
    expect(panelSource).toContain(
      "getComputeContext(props.contextId)?.sessionId !== target.sessionId",
    );
    expect(panelSource).toContain("sessionId: target.sessionId");
    expect(panelSource).toContain("expectedGeneration: target.generation");
    expect(panelSource).toContain("shrink-0 flex-wrap items-center gap-2");
  });

  it("keeps text, errors, figures and live variables in one progressive result surface", () => {
    expect(outputSource).toContain('case "stream"');
    expect(outputSource).toContain('case "diagnostic"');
    expect(outputSource).toContain('case "image"');
    expect(panelSource).toContain("Variables");
    expect(panelSource).toContain("not saved in run history");
    expect(outputSource).toContain("diagnostic.frames");
    expect(outputSource).not.toContain("traceback.match");
    expect(outputSource).not.toContain("File \\\\s+");
  });

  it("keeps Python setup contextual to the file toolbar", () => {
    expect(pythonActionsSource).toContain("resolveComputeRuntimeToolbarState");
    expect(pythonActionsSource).toContain("Open Scientific Computing settings");
    expect(pythonActionsSource).toContain(
      "aria-label={`Refresh ${props.language.displayName} detection`}",
    );
    expect(pythonActionsSource).toContain('runtimeToolbar.kind === "switch"');
    expect(pythonActionsSource).toContain("the next run uses the");
    expect(pythonActionsSource).toContain(
      "{props.language.displayName} selected in Scientific Computing",
    );
    expect(pythonActionsSource).not.toContain("Settings2");
    expect(panelSource).toContain("if (props.contextId === undefined) return allSessions;");
    expect(panelSource).toContain(
      "return allSessions.filter((session) => session.sessionId === contextBinding.sessionId);",
    );
    expect(panelSource).toContain("!props.embedded && contextSessions.length > 0");
  });

  it("keeps the Python file toolbar usable as its panel narrows", () => {
    expect(pythonSurfaceSource).toContain("flex-wrap items-center gap-x-2 gap-y-1");
    expect(pythonSurfaceSource).toContain('className="min-w-22 flex-1"');
    expect(pythonActionsSource).toContain("@container/python-file-actions");
    expect(pythonActionsSource).toContain("@[9rem]/python-file-actions:block");
    expect(pythonActionsSource).toContain("@[15rem]/python-file-actions:inline");
    expect(pythonActionsSource).toContain("aria-label={primary.label}");
    expect(pythonSurfaceSource).toContain('useState<ComputeFileView>("code")');
    expect(pythonSurfaceSource).toContain(
      "setView((current) => computeFileViewAfterRun(current, preferredResultsView))",
    );
    expect(pythonActionsSource).toContain("onRunRequested();");
    expect(panelSource).toContain("onClick={props.onRunSource}");
    expect(panelSource).toContain("<Play /> Run");
    expect(panelSource).toContain("<span>to see results.</span>");
    expect(panelSource).toContain("!props.embedded && contextBinding !== null");
    expect(panelSource.indexOf("onClick={props.onRunSource}")).toBeLessThan(
      panelSource.indexOf("Start a scientific session"),
    );
    expect(pythonActionsSource).toContain("Switch {props.language.displayName} environment…");
  });

  it("sizes shared setup-card actions by the panel rather than the window", () => {
    expect(settingsSource).toContain("@container/managed-runtime");
    expect(settingsSource).toContain("@[32rem]/managed-runtime:flex-row");
  });

  it("refreshes the current workspace tree after successful or failed executions", () => {
    expect(panelSource).toContain(
      "TERMINAL_COMPUTE_EXECUTION_STATUSES.has(execution.result.status)",
    );
    expect(panelSource).toContain("refreshProjectFiles(props.environmentId, props.cwd)");
    expect(panelSource).not.toContain("getProjectEntriesQueryAtom");
  });

  it("focuses a new run in the session that actually owns it", () => {
    expect(pythonActionsSource).toContain(
      "props.onExecutionSubmitted(session.sessionId, executionId)",
    );
    expect(pythonSurfaceSource).toContain("focusSessionId={focusExecution?.sessionId ?? null}");
    expect(panelSource).toContain("setSelectedSessionId(props.focusSessionId)");
  });

  it("follows only current stable figures through passive generic surfaces", () => {
    expect(panelSource).toContain("selectedIsCurrentResult");
    expect(panelSource).toContain("allowFigureFollowing={selectedIsCurrentResult}");
    expect(outputSource).toContain("computeFigurePresentation");
    expect(outputSource).toContain("StaticArtifactPresentationMenu");
    expect(outputSource).toContain("StaticArtifactPresentationActionMenu");
    expect(outputSource).toContain("StaticImageCopyButton");
    expect(outputSource).toContain("StaticImageDownloadButton");
    expect(outputSource).toContain("artifact={props.presentation.viewer}");
    expect(outputSource).toContain('assetUrl={asset._tag === "Success" ? asset.url : null}');
    expect(artifactMenusSource).toContain("Open in viewer");
    expect(artifactMenusSource).toContain("Floating card");
    expect(imageActionButtonsSource).toContain("Copy image");
    expect(imageActionButtonsSource).toContain("Download original");
    expect(artifactMenusSource).not.toContain("Interactive");
    expect(artifactMenusSource).toContain("toggleStaticArtifactFloating");
    expect(artifactMenusSource).toContain("openStaticArtifactInPanel");
    expect(artifactPreviewSource).toContain("toggleStaticArtifactFloating");
    expect(artifactViewerActionsSource).toContain("openScientArtifact");
    expect(artifactViewerActionsSource).toContain("openArtifact");
    expect(artifactViewerActionsSource).toContain("closeSurface");
    expect(followerSource).toContain("updateScientArtifact");
    expect(followerSource).toContain("updateArtifact");
    expect(followerSource).not.toContain("openScientArtifact");
    expect(followerSource).not.toContain("openArtifact");
    expect(followerSource).toContain("if (events.data?.stale || latestSession === null) return;");
    expect(followerSource).toContain("if (events.data?.stale) return null;");
  });
});
