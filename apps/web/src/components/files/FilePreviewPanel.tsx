import { Spinner } from "~/components/ui/spinner";
import type {
  ChatFileAttachment,
  EditorId,
  EnvironmentId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  VirtualizedFile,
  type EditorSelection,
  type GetHoveredLineResult,
  type SelectedLineRange,
} from "@pierre/diffs";
import { isWorkspaceVideoPreviewPath } from "@t3tools/shared/filePreview";
import { Editor } from "@pierre/diffs/editor";
import { EditProvider, File, type FileOptions, Virtualizer } from "@pierre/diffs/react";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import { Code2, Eye, FolderTree, Globe2 } from "lucide-react";
import * as Schema from "effect/Schema";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { isBrowserPreviewFile, openFileInPreview } from "~/browser/openFileInPreview";
import type { FileCitation } from "@t3tools/contracts";
import type { MarkdownCiteHandler } from "~/scient/markdownEditor/markdownCitation";
import { useAssetUrlRefresh, useAssetUrlState } from "~/assets/assetUrls";
import { OpenInPicker } from "~/components/chat/OpenInPicker";
import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { MediaVideoPlayer } from "~/components/media/MediaVideoPlayer";
import { MediaActions, type MediaActionSource } from "~/components/media/MediaActions";
import { useRemoteOpenState } from "~/remoteOpen";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "~/hooks/useLocalStorage";
import { DIFF_SURFACE_THEME_UNSAFE_CSS, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { cn } from "~/lib/utils";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import type { HtmlFilePresentationRequest, LatexFilePresentationRequest } from "~/rightPanelStore";
import { isAbsolutePath, resolvePathLinkTarget } from "~/terminal-links";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Toggle } from "~/components/ui/toggle";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { buildFileReviewComment } from "~/reviewCommentContext";
import { assetEnvironment } from "~/state/assets";
import { useEnvironmentHttpBaseUrl, usePrimaryEnvironmentId } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import {
  SCIENT_DEFAULT_RENDER_MARKDOWN,
  resolveHtmlRenderedState,
  resolveInitialFileExplorerOpen,
} from "~/scient/fileOpening/fileOpeningPolicy";
import { scientificSourceLanguageOverride } from "~/scient/analysis/sourceLanguage";
import { ScientFileAuxiliarySurface } from "~/scient/fileSurfaces/ScientFileAuxiliarySurface";
import { computeSourceLanguageForPath } from "~/scient/compute/computeSourceLanguage";
import { computeFileContextId } from "~/scient/compute/computeContextStore";
import { ScientMarkdownRenameButton } from "~/scient/markdownEditor/ui/ScientMarkdownRenameButton";
import {
  isScientMarkdownDocumentPath,
  shouldUseScientMarkdownEditor,
} from "~/scient/markdownEditor/markdownDocumentPaths";
import { ScientMarkdownPersistenceNotice } from "~/scient/markdownEditor/ui/ScientMarkdownPersistenceNotice";
import { useMarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceLease";
import { useMarkdownPersistenceGuards } from "~/scient/markdownEditor/persistence/useMarkdownPersistenceGuards";
import { useMarkdownSourcePersistence } from "~/scient/markdownEditor/persistence/useMarkdownSourcePersistence";
import type { MarkdownPersistenceLease } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { markdownPersistenceRegistry } from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { workspacePdfSourceForPreview } from "~/scient/pdf/pdfSource";
import {
  ScientFileFreshnessNotices,
  ScientFileReloadButton,
} from "~/scient/fileSurfaces/ScientFileFreshnessControls";
import {
  type FileSaveResolution,
  useWorkspaceFileRefresh,
} from "~/scient/fileSurfaces/useWorkspaceFileRefresh";
import { usePendingSurfaceDeparture } from "~/scient/fileSurfaces/usePendingSurfaceDeparture";

import FileBrowserPanel from "./FileBrowserPanel";
import { FileBreadcrumbs } from "./FileBreadcrumbs";
import { FileMarkdownPreview } from "./FileMarkdownPreview";
import {
  type FileCommentAnnotationEntry,
  type FileCommentAnnotationGroup,
  type FileCommentLineAnnotation,
  formatFileCommentRange,
  nextFileCommentId,
  normalizeFileCommentRange,
  remapFileCommentAnnotations,
} from "./fileCommentAnnotations";
import { installFileEditorDismissal } from "./fileEditorDismissal";
import { resolveCenteredFileLineScrollTop } from "./fileLineReveal";
import { DiffCommentAnnotation } from "../diffs/DiffCommentAnnotation";
import { projectFileCacheKey, projectFileEditorCacheKey } from "./fileContentRevision";
import { FileBreadcrumbNavigator } from "./FileBreadcrumbNavigator";
import {
  isLatexPreviewFile,
  isMarkdownPreviewFile,
  resolveMarkdownTaskPreviewUpdate,
  resolveFilePreviewKind,
  shouldLoadFileAsText,
  shouldShowFileExplorer,
} from "./filePreviewMode";
import { useFileSaveCoordinator } from "./useFileSaveCoordinator";
import {
  clearProjectFileQueryData,
  getOptimisticProjectFileQueryData,
  refreshProjectEntriesQuery,
  setProjectFileQueryData,
} from "./projectFilesQueryState";

interface FilePreviewPanelProps {
  onCiteFile?: MarkdownCiteHandler;
  fileCitation?: FileCitation | undefined;
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  relativePath: string | null;
  attachment?: ChatFileAttachment;
  threadRef: ScopedThreadRef;
  composerDraftTarget: ScopedThreadRef | DraftId;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  revealLine: number | null;
  revealRequestId: number;
  htmlPresentationRequest: HtmlFilePresentationRequest | null;
  latexPresentationRequest: LatexFilePresentationRequest | null;
  onOpenFile: (relativePath: string) => void;
  onOpenFileSource: (relativePath: string, line?: number) => void;
  onHtmlPresentationRequestHandled: (
    relativePath: string,
    request: HtmlFilePresentationRequest,
  ) => void;
  onLatexPresentationRequestHandled: (
    relativePath: string,
    request: LatexFilePresentationRequest,
  ) => void;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  selectedFilePending: boolean;
  workspaceMutationId: string | null;
}

const FILE_EXPLORER_STORAGE_KEY = "t3code.fileExplorerOpen";
const RENDER_MARKDOWN_STORAGE_KEY = "t3code.renderMarkdown";
const RENDER_BROWSER_FILE_STORAGE_KEY = "t3code.renderBrowserFile";
const FILE_LINK_REVEAL_ATTRIBUTE = "data-file-link-reveal";
const FILE_ACTIVE_RANGE_ATTRIBUTE = "data-scient-active-range";
const FILE_LINK_REVEAL_UNSAFE_CSS = `
  ${DIFF_SURFACE_THEME_UNSAFE_CSS}

  diffs-container {
    --diffs-bg: var(--code-background, var(--background)) !important;
    --diffs-light-bg: var(--code-background, var(--background)) !important;
    --diffs-dark-bg: var(--code-background, var(--background)) !important;
    background-color: var(--code-background, var(--background)) !important;
    color: var(--code-foreground, var(--foreground)) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-line] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 82%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-override, var(--diffs-selection-base))
      )
    ) !important;
  }

  [${FILE_LINK_REVEAL_ATTRIBUTE}][data-column-number] {
    background-color: light-dark(
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 75%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      ),
      color-mix(
        in lab,
        var(--diffs-computed-diff-line-bg) 60%,
        var(--diffs-bg-selection-number-override, var(--diffs-selection-base))
      )
    ) !important;
    color: var(--diffs-selection-number-fg) !important;
  }

  :host([${FILE_ACTIVE_RANGE_ATTRIBUTE}]) [data-line][data-selected-line] {
    background-color: light-dark(
      color-mix(in srgb, var(--primary) 8%, transparent),
      color-mix(in srgb, var(--primary) 12%, transparent)
    ) !important;
  }

  :host([${FILE_ACTIVE_RANGE_ATTRIBUTE}]) [data-column-number][data-selected-line] {
    background-color: light-dark(
      color-mix(in srgb, var(--primary) 13%, transparent),
      color-mix(in srgb, var(--primary) 18%, transparent)
    ) !important;
    color: var(--diffs-fg-number) !important;
  }
`;
const FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS = `
  ${FILE_LINK_REVEAL_UNSAFE_CSS}

  [data-gutter-utility-slot] {
    right: auto;
    left: 0;
    justify-content: flex-start;
  }
`;
const ScientPdfReader = lazy(() =>
  import("~/scient/pdf/ScientPdfReader").then((module) => ({
    default: module.ScientPdfReader,
  })),
);
const ScientLatexSurface = lazy(() =>
  import("~/scient/latex/ScientLatexSurface").then((module) => ({
    default: module.ScientLatexSurface,
  })),
);
const ScientComputeFileSurface = lazy(() =>
  import("~/scient/compute/ScientComputeFileSurface").then((module) => ({
    default: module.ScientComputeFileSurface,
  })),
);
const ScientMarkdownFileSurface = lazy(() =>
  import("~/scient/markdownEditor/ScientMarkdownFileSurface").then((module) => ({
    default: module.ScientMarkdownFileSurface,
  })),
);
type FilePostRender = NonNullable<FileOptions<unknown>["onPostRender"]>;

function StaticTextFileSurface(props: {
  readonly contents: string;
  readonly cwd: string;
  readonly onPostRender: FilePostRender;
  readonly relativePath: string;
  readonly resolvedTheme: "light" | "dark";
  readonly wordWrap: boolean;
}) {
  return (
    <DiffWorkerPoolProvider>
      <Virtualizer
        className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
        config={{ overscrollSize: 600, intersectionObserverMargin: 1200 }}
      >
        <File
          file={{
            name: props.relativePath,
            contents: props.contents,
            ...scientificSourceLanguageOverride(props.relativePath),
            cacheKey: projectFileCacheKey(props.cwd, props.relativePath, props.contents),
          }}
          options={{
            disableFileHeader: true,
            overflow: props.wordWrap ? "wrap" : "scroll",
            theme: resolveDiffThemeName(props.resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
            themeType: props.resolvedTheme,
            unsafeCSS: FILE_LINK_REVEAL_UNSAFE_CSS,
            onPostRender: props.onPostRender,
          }}
          className="min-h-full"
        />
      </Virtualizer>
    </DiffWorkerPoolProvider>
  );
}

function WorkspaceImagePreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly alt: string;
  readonly refreshKey: number;
}) {
  const resource = useMemo(
    () => ({
      _tag: "workspace-file" as const,
      cwd: props.workspaceRoot,
      relativePath: props.relativePath,
      threadId: props.threadRef.threadId,
      path: props.absolutePath,
    }),
    [props.absolutePath, props.relativePath, props.threadRef.threadId, props.workspaceRoot],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const previousRefreshKey = useRef(props.refreshKey);

  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    setFailedUrl(null);
    assetUrl.refresh();
  }, [assetUrl.refresh, props.refreshKey]);
  const revisionSuffix =
    props.refreshKey === 0
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${props.refreshKey}`;
  const imageUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;
  const actionsSource: MediaActionSource = {
    kind: "image",
    name: props.alt,
    src: imageUrl,
    reference: mediaFileReference(props.absolutePath, props.workspaceRoot),
    asset: { environmentId: props.environmentId, resource },
  };

  if (assetUrl._tag === "Failure" || (imageUrl !== null && failedUrl === imageUrl)) {
    return (
      <MediaActions source={actionsSource}>
        <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
          Unable to load workspace image.
        </div>
      </MediaActions>
    );
  }

  return assetUrl._tag === "Success" && imageUrl !== null ? (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
      <MediaActions source={actionsSource}>
        <img
          className="max-h-full max-w-full object-contain"
          src={imageUrl}
          alt={props.alt}
          onError={() => setFailedUrl(imageUrl)}
        />
      </MediaActions>
    </div>
  ) : (
    <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
      <Spinner className="size-5" />
    </div>
  );
}

const isPdfPreviewFile = (path: string): boolean => /\.pdf$/i.test(path.split(/[?#]/, 1)[0] ?? "");

function BrowserDocumentFrame(props: {
  readonly src: string;
  readonly title: string;
  readonly pdf: boolean;
}) {
  const className = "min-h-0 flex-1 border-0 bg-white";
  // The built-in PDF viewer needs an unsandboxed frame; a PDF runs no scripts.
  return props.pdf ? (
    // oxlint-disable-next-line react/iframe-missing-sandbox
    <iframe key={props.src} src={props.src} title={props.title} className={className} />
  ) : (
    <iframe
      key={props.src}
      src={props.src}
      title={props.title}
      className={className}
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
    />
  );
}

function AttachmentBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly attachment: ChatFileAttachment;
}) {
  const resource = useMemo(
    () => ({
      _tag: "attachment" as const,
      attachmentId: props.attachment.id,
      fileName: props.attachment.name,
      mimeType: props.attachment.mimeType,
      disposition: "inline" as const,
    }),
    [props.attachment.id, props.attachment.mimeType, props.attachment.name],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load attachment preview.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={assetUrl.url}
      title={props.attachment.name}
      pdf={
        isPdfPreviewFile(props.attachment.name) ||
        props.attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() === "application/pdf"
      }
    />
  );
}
/**
 * Renders an HTML or PDF file in place from its signed asset URL. HTML runs in
 * a sandboxed frame with an opaque origin, so a page cannot reach the app's
 * session or storage. A file inside the workspace may load sibling assets; a
 * host file outside it is served on its own.
 */
function WorkspaceBrowserPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly title: string;
  readonly refreshKey: number;
}) {
  const reference = mediaFileReference(props.absolutePath, props.workspaceRoot);
  const insideWorkspace = reference.relativePath !== undefined;
  const resource = useMemo(
    () =>
      insideWorkspace
        ? {
            _tag: "workspace-file" as const,
            cwd: props.workspaceRoot,
            relativePath: props.relativePath,
            threadId: props.threadRef.threadId,
            path: props.absolutePath,
          }
        : {
            _tag: "media-file" as const,
            threadId: props.threadRef.threadId,
            path: props.absolutePath,
          },
    [
      insideWorkspace,
      props.absolutePath,
      props.relativePath,
      props.threadRef.threadId,
      props.workspaceRoot,
    ],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const previousRefreshKey = useRef(props.refreshKey);

  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    assetUrl.refresh();
  }, [assetUrl.refresh, props.refreshKey]);
  const revisionSuffix =
    props.refreshKey === 0
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${props.refreshKey}`;

  if (assetUrl._tag === "Failure") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
        Unable to load file preview.
      </div>
    );
  }
  if (assetUrl._tag !== "Success") {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <Spinner className="size-5" />
      </div>
    );
  }
  return (
    <BrowserDocumentFrame
      src={`${assetUrl.url}${revisionSuffix}`}
      title={props.title}
      pdf={isPdfPreviewFile(props.absolutePath)}
    />
  );
}

function WorkspaceVideoPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly absolutePath: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly name: string;
  readonly refreshKey: number;
}) {
  const reference = mediaFileReference(props.absolutePath, props.workspaceRoot);
  const insideWorkspace = reference.relativePath !== undefined;
  const resource = useMemo(
    () =>
      insideWorkspace
        ? {
            _tag: "workspace-file" as const,
            cwd: props.workspaceRoot,
            relativePath: props.relativePath,
            threadId: props.threadRef.threadId,
            path: props.absolutePath,
          }
        : {
            _tag: "media-file" as const,
            threadId: props.threadRef.threadId,
            path: props.absolutePath,
          },
    [
      insideWorkspace,
      props.absolutePath,
      props.relativePath,
      props.threadRef.threadId,
      props.workspaceRoot,
    ],
  );
  const assetUrl = useAssetUrlState(props.environmentId, resource);
  const refreshAssetUrl = useAssetUrlRefresh(props.environmentId, resource);
  const previousRefreshKey = useRef(props.refreshKey);

  useEffect(() => {
    if (previousRefreshKey.current === props.refreshKey) return;
    previousRefreshKey.current = props.refreshKey;
    void refreshAssetUrl().catch(() => undefined);
  }, [props.refreshKey, refreshAssetUrl]);
  const revisionSuffix =
    props.refreshKey === 0
      ? ""
      : `${assetUrl._tag === "Success" && assetUrl.url.includes("?") ? "&" : "?"}workspace-revision=${props.refreshKey}`;
  const latestUrl = assetUrl._tag === "Success" ? `${assetUrl.url}${revisionSuffix}` : null;

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4">
      <MediaVideoPlayer
        src={latestUrl}
        sourceFailed={assetUrl._tag === "Failure"}
        label={props.name}
        revision={String(props.refreshKey)}
        preload="metadata"
        className="flex h-full min-h-0 w-full max-w-5xl items-center justify-center"
        onRetry={refreshAssetUrl}
        actionsSource={{
          kind: "video",
          name: props.name,
          src: latestUrl,
          reference,
          asset: { environmentId: props.environmentId, resource },
        }}
      />
    </div>
  );
}

function clampFileLine(contents: string, requestedLine: number): number {
  let lineCount = 1;
  for (let index = 0; index < contents.length; index += 1) {
    const character = contents.charCodeAt(index);
    if (character === 10) {
      lineCount += 1;
    } else if (character === 13) {
      lineCount += 1;
      if (contents.charCodeAt(index + 1) === 10) index += 1;
    }
  }
  return Math.min(Math.max(1, requestedLine), lineCount);
}

function updateFileLinkReveal(fileContainer: HTMLElement, line: number | null): void {
  const root = fileContainer.shadowRoot ?? fileContainer;
  for (const element of root.querySelectorAll<HTMLElement>(`[${FILE_LINK_REVEAL_ATTRIBUTE}]`)) {
    element.removeAttribute(FILE_LINK_REVEAL_ATTRIBUTE);
  }
  if (line === null) return;

  root
    .querySelector<HTMLElement>(`[data-line="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
  root
    .querySelector<HTMLElement>(`[data-column-number="${line}"]`)
    ?.setAttribute(FILE_LINK_REVEAL_ATTRIBUTE, "");
}

/**
 * Frames to keep retrying while the file contents or line metrics are not
 * available yet (fresh mounts hydrate asynchronously).
 */
const REVEAL_MAX_ATTEMPTS = 30;
/**
 * After scrolling to the target, hold it for a short window so late
 * programmatic scroll resets (editable-editor focus and state restoration)
 * cannot silently snap the file back to the top. Real user input cancels the
 * guard immediately.
 */
const REVEAL_GUARD_FRAMES = 20;
const REVEAL_GUARD_TOLERANCE_PX = 2;

interface FileRevealState {
  frameId: number | null;
  cancelGuard: (() => void) | null;
  handledRequestId: number | null;
  latestRequestId: number | null;
}

function useFileLineReveal(
  relativePath: string | null,
  revealLine: number | null,
  revealRequestId: number,
): FilePostRender {
  const [revealStatesByPath] = useState(() => new Map<string, FileRevealState>());

  return useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      if (relativePath === null) return;

      const existingState = revealStatesByPath.get(relativePath);
      const state: FileRevealState = existingState ?? {
        frameId: null,
        cancelGuard: null,
        handledRequestId: null,
        latestRequestId: null,
      };
      if (!existingState) revealStatesByPath.set(relativePath, state);

      const cancelPendingReveal = () => {
        if (state.frameId !== null) {
          cancelAnimationFrame(state.frameId);
          state.frameId = null;
        }
        state.cancelGuard?.();
      };

      if (phase === "unmount") {
        cancelPendingReveal();
        return;
      }

      const contents = instance.file?.contents;
      const targetLine =
        revealLine === null || contents === undefined ? null : clampFileLine(contents, revealLine);
      updateFileLinkReveal(fileContainer, targetLine);

      if (!(instance instanceof VirtualizedFile)) return;

      if (state.latestRequestId !== revealRequestId) {
        cancelPendingReveal();
        state.latestRequestId = revealRequestId;
        state.handledRequestId = null;
      }

      if (revealLine === null) {
        fileContainer.style.minHeight = "";
        return;
      }

      const scrollContainer = fileContainer.closest<HTMLElement>(".file-preview-virtualizer");
      if (!scrollContainer) return;
      fileContainer.style.minHeight = `${Math.ceil(
        Math.max(instance.height, scrollContainer.clientHeight),
      )}px`;

      if (state.handledRequestId === revealRequestId || state.frameId !== null) {
        return;
      }

      const resolveScrollTarget = (line: number): number | null => {
        const linePosition = instance.getLinePosition(line);
        if (!linePosition) return null;

        const scrollContainerRect = scrollContainer.getBoundingClientRect();
        const fileTop =
          scrollContainer.scrollTop +
          fileContainer.getBoundingClientRect().top -
          scrollContainerRect.top;
        const root = fileContainer.shadowRoot ?? fileContainer;
        const renderedLineElement = root.querySelector<HTMLElement>(`[data-line="${line}"]`);
        const renderedLineRect = renderedLineElement?.getBoundingClientRect();

        return resolveCenteredFileLineScrollTop({
          scrollTop: scrollContainer.scrollTop,
          scrollHeight: scrollContainer.scrollHeight,
          viewportTop: scrollContainerRect.top,
          viewportHeight: scrollContainer.clientHeight,
          fileTop,
          estimatedLine: linePosition,
          ...(renderedLineRect && renderedLineRect.height > 0
            ? {
                renderedLine: {
                  top: renderedLineRect.top,
                  height: renderedLineRect.height,
                },
              }
            : {}),
        });
      };

      const guardScrollTarget = (line: number) => {
        let framesLeft = REVEAL_GUARD_FRAMES;
        let guardFrameId: number | null = null;
        const cancelGuard = () => {
          if (guardFrameId !== null) {
            cancelAnimationFrame(guardFrameId);
            guardFrameId = null;
          }
          scrollContainer.removeEventListener("wheel", cancelGuard);
          scrollContainer.removeEventListener("touchstart", cancelGuard);
          scrollContainer.removeEventListener("pointerdown", cancelGuard, true);
          window.removeEventListener("keydown", cancelGuard, true);
          if (state.cancelGuard === cancelGuard) state.cancelGuard = null;
        };
        scrollContainer.addEventListener("wheel", cancelGuard, { passive: true });
        scrollContainer.addEventListener("touchstart", cancelGuard, { passive: true });
        // Pierre stops gutter pointer events from bubbling. Listen in capture
        // so starting a comment cancels the reveal guard before the row expands.
        scrollContainer.addEventListener("pointerdown", cancelGuard, {
          passive: true,
          capture: true,
        });
        window.addEventListener("keydown", cancelGuard, true);
        const holdTarget = () => {
          guardFrameId = null;
          framesLeft -= 1;
          if (framesLeft <= 0 || !scrollContainer.isConnected) {
            cancelGuard();
            return;
          }
          const targetTop = resolveScrollTarget(line);
          if (
            targetTop !== null &&
            Math.abs(scrollContainer.scrollTop - targetTop) > REVEAL_GUARD_TOLERANCE_PX
          ) {
            scrollContainer.scrollTop = targetTop;
          }
          guardFrameId = requestAnimationFrame(holdTarget);
        };
        guardFrameId = requestAnimationFrame(holdTarget);
        state.cancelGuard = cancelGuard;
      };

      const scheduleReveal = (attempt: number) => {
        state.frameId = requestAnimationFrame(() => {
          state.frameId = null;
          if (state.latestRequestId !== revealRequestId || !fileContainer.isConnected) {
            return;
          }

          // Contents and line metrics can lag the first post-render on fresh
          // mounts; clamping against missing contents would scroll to line 1
          // and wrongly mark the request handled.
          const currentContents = instance.file?.contents;
          const line =
            currentContents === undefined ? null : clampFileLine(currentContents, revealLine);
          const targetTop = line === null ? null : resolveScrollTarget(line);
          if (line === null || targetTop === null) {
            if (attempt < REVEAL_MAX_ATTEMPTS) scheduleReveal(attempt + 1);
            return;
          }
          updateFileLinkReveal(fileContainer, line);

          scrollContainer.scrollTop = targetTop;
          state.handledRequestId = revealRequestId;
          guardScrollTarget(line);
        });
      };

      scheduleReveal(0);
    },
    [revealStatesByPath, relativePath, revealLine, revealRequestId],
  );
}

interface EditableFileSurfaceProps {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  composerDraftTarget: ScopedThreadRef | DraftId;
  contents: string;
  revision: string;
  resolvedTheme: "light" | "dark";
  revealRequestId: number;
  wordWrap: boolean;
  onPostRender: FilePostRender;
  onPendingChange: (relativePath: string, pending: boolean) => void;
  onSaveFailure: (relativePath: string, error: unknown) => void;
  onSaveConfirmed: (relativePath: string, contents: string, revision: string) => void;
  onSaveResolutionApplied: () => void;
  saveResolution: FileSaveResolution | null;
  onSelectionChange?: (range: SelectedLineRange | null) => void;
  activeLineRange?: SelectedLineRange | null;
  onEditorSelectionChange?: (selection: EditorSelection | null) => void;
  renderEditorGutterAction?: (
    getHoveredLine: () => GetHoveredLineResult<"file"> | undefined,
  ) => ReactNode;
  onRunShortcut?: (selection: EditorSelection | null) => void;
}

interface FileSelectionOverride {
  revealRequestId: number;
  range: SelectedLineRange | null;
}

export function EditableFileSurface(props: EditableFileSurfaceProps) {
  const coordinator = useFileSaveCoordinator(props);
  const onContentsChange = useCallback(
    (contents: string) => {
      setProjectFileQueryData(props.environmentId, props.cwd, props.relativePath, contents);
      coordinator.change(contents);
    },
    [coordinator, props.environmentId, props.cwd, props.relativePath],
  );
  return <EditableFileEditor {...props} onContentsChange={onContentsChange} />;
}

export function MarkdownSourceSurface({
  persistence,
  ...props
}: Omit<Parameters<typeof EditableFileEditor>[0], "contents" | "revision" | "onContentsChange"> & {
  persistence: MarkdownPersistenceLease;
}) {
  const bindings = useMarkdownSourcePersistence(persistence);
  return <EditableFileEditor {...props} {...bindings} />;
}

function EditableFileEditor({
  environmentId,
  cwd,
  relativePath,
  composerDraftTarget,
  contents,
  resolvedTheme,
  revealRequestId,
  wordWrap,
  onPostRender,
  onContentsChange,
  onProjectionApplied,
  externalPersistence,
  onExternalVersionApplied,
  editingBlocked = false,
  onSelectionChange,
  activeLineRange,
  onEditorSelectionChange,
  renderEditorGutterAction,
  onRunShortcut,
}: Omit<
  EditableFileSurfaceProps,
  | "onPendingChange"
  | "onSaveFailure"
  | "onSaveConfirmed"
  | "onSaveResolutionApplied"
  | "saveResolution"
> & {
  onContentsChange: (source: string) => void;
  onProjectionApplied?: (source: string) => void;
  externalPersistence?: MarkdownPersistenceLease;
  onExternalVersionApplied?: (version: number) => void;
  editingBlocked?: boolean;
}) {
  const addReviewComment = useComposerDraftStore((store) => store.addReviewComment);
  const removeReviewComment = useComposerDraftStore((store) => store.removeReviewComment);
  const [lineAnnotations, setLineAnnotations] = useState<FileCommentLineAnnotation[]>([]);
  const [selectionOverride, setSelectionOverride] = useState<FileSelectionOverride | null>(null);
  const selectedRange =
    selectionOverride?.revealRequestId === revealRequestId ? selectionOverride.range : null;
  const displayedRange = selectedRange ?? activeLineRange ?? null;
  const setSelectedRange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionOverride({ revealRequestId, range });
      onSelectionChange?.(range);
    },
    [onSelectionChange, revealRequestId],
  );
  const surfaceRef = useRef<HTMLDivElement>(null);
  const selectionFrameRef = useRef<number | null>(null);
  const editorSelectionFrameRef = useRef<number | null>(null);
  const reportEditorSelectionRef = useRef<() => void>(() => undefined);
  const projectionAppliedRef = useRef(onProjectionApplied);
  projectionAppliedRef.current = onProjectionApplied;
  const applyingExternal = useRef(false);
  const externalBindings = useRef({ externalPersistence, onExternalVersionApplied });
  externalBindings.current = { externalPersistence, onExternalVersionApplied };
  const editor = useMemo(
    () =>
      new Editor<FileCommentAnnotationGroup>({
        persistState: true,
        persistStateStorage: "inMemory",
        onAttach: (attachedEditor) => {
          const projected = attachedEditor.getFile();
          if (projected) projectionAppliedRef.current?.(projected.contents);
          queueMicrotask(() =>
            externalBindings.current.externalPersistence?.resumeExternalUpdates(),
          );
        },
        onChange: (file, nextLineAnnotations) => {
          if (!applyingExternal.current) onContentsChange(file.contents);
          if (nextLineAnnotations) {
            const remapped = remapFileCommentAnnotations(
              nextLineAnnotations as FileCommentLineAnnotation[],
            );
            setLineAnnotations(remapped);
            for (const annotation of remapped) {
              for (const entry of annotation.metadata.entries) {
                if (entry.kind !== "comment") continue;
                addReviewComment(
                  composerDraftTarget,
                  buildFileReviewComment({
                    id: entry.id,
                    filePath: relativePath,
                    startLine: entry.startLine,
                    endLine: entry.endLine,
                    text: entry.text,
                    contents: file.contents,
                  }),
                );
              }
            }
          }
          queueMicrotask(() => reportEditorSelectionRef.current());
        },
        onFocus: () => queueMicrotask(() => reportEditorSelectionRef.current()),
      }),
    [addReviewComment, composerDraftTarget, onContentsChange, relativePath],
  );

  useLayoutEffect(
    () =>
      externalPersistence?.registerExternalProjection((update) => {
        if (!editor.getFile() || editor.isComposing) return "defer";
        const prepared = editor.prepareExternalEdits(
          update.previousSource,
          update.patches.map((patch) => ({
            start: patch.start,
            end: patch.end,
            text: patch.replacement,
          })),
        );
        if (!prepared) return null;
        return () => {
          applyingExternal.current = true;
          try {
            prepared();
            externalBindings.current.onExternalVersionApplied?.(update.editVersion);
          } finally {
            applyingExternal.current = false;
          }
        };
      }),
    [editor, externalPersistence],
  );

  const reportEditorSelection = useCallback(() => {
    if (onEditorSelectionChange === undefined) return;
    if (editorSelectionFrameRef.current !== null) {
      cancelAnimationFrame(editorSelectionFrameRef.current);
    }
    editorSelectionFrameRef.current = requestAnimationFrame(() => {
      editorSelectionFrameRef.current = null;
      onEditorSelectionChange(editor.getState().selections?.at(-1) ?? null);
    });
  }, [editor, onEditorSelectionChange]);
  reportEditorSelectionRef.current = reportEditorSelection;

  useEffect(() => {
    if (onEditorSelectionChange === undefined) return;
    const handleSelectionChange = () => {
      const surface = surfaceRef.current;
      if (surface === null || !surface.contains(document.activeElement)) return;
      reportEditorSelection();
    };
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (editorSelectionFrameRef.current !== null) {
        cancelAnimationFrame(editorSelectionFrameRef.current);
        editorSelectionFrameRef.current = null;
      }
    };
  }, [onEditorSelectionChange, reportEditorSelection]);

  const removeAnnotationEntry = useCallback(
    (entryId: string) => {
      setSelectedRange(null);
      removeReviewComment(composerDraftTarget, entryId);
      setLineAnnotations((current) => {
        return current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.id !== entryId);
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
      });
    },
    [composerDraftTarget, removeReviewComment, setSelectedRange],
  );

  const submitAnnotationEntry = useCallback(
    (entryId: string, text: string) => {
      setSelectedRange(null);
      const entry = lineAnnotations
        .flatMap((annotation) => annotation.metadata.entries)
        .find((candidate) => candidate.id === entryId);
      if (entry) {
        addReviewComment(
          composerDraftTarget,
          buildFileReviewComment({
            id: entry.id,
            filePath: relativePath,
            startLine: entry.startLine,
            endLine: entry.endLine,
            text,
            contents,
          }),
        );
      }
      setLineAnnotations((current) =>
        current.map((annotation) => ({
          ...annotation,
          metadata: {
            entries: annotation.metadata.entries.map((annotationEntry) =>
              annotationEntry.id === entryId
                ? { ...annotationEntry, kind: "comment", text }
                : annotationEntry,
            ),
          },
        })),
      );
    },
    [
      addReviewComment,
      composerDraftTarget,
      contents,
      lineAnnotations,
      relativePath,
      setSelectedRange,
    ],
  );

  const beginComment = useCallback(
    (range: SelectedLineRange) => {
      editor.setSelections([]);
      editor.blur();
      const { startLine, endLine } = normalizeFileCommentRange(range);
      const draftEntry: FileCommentAnnotationEntry = {
        id: nextFileCommentId(),
        kind: "draft",
        startLine,
        endLine,
        text: "",
      };
      setLineAnnotations((current) => {
        const withoutDraft = current.flatMap((annotation) => {
          const entries = annotation.metadata.entries.filter((entry) => entry.kind !== "draft");
          return entries.length > 0 ? [{ ...annotation, metadata: { entries } }] : [];
        });
        const existingIndex = withoutDraft.findIndex(
          (annotation) => annotation.lineNumber === endLine,
        );
        if (existingIndex < 0) {
          return [
            ...withoutDraft,
            {
              lineNumber: endLine,
              metadata: { entries: [draftEntry] },
            },
          ];
        }
        return withoutDraft.map((annotation, index) =>
          index === existingIndex
            ? {
                ...annotation,
                metadata: { entries: [...annotation.metadata.entries, draftEntry] },
              }
            : annotation,
        );
      });
    },
    [editor],
  );
  const hasOpenCommentForm = lineAnnotations.some((annotation) =>
    annotation.metadata.entries.some((entry) => entry.kind === "draft"),
  );
  useEffect(() => {
    const root = surfaceRef.current;
    if (!root) return;
    return installFileEditorDismissal({
      root,
      editor,
      isBlocked: () => hasOpenCommentForm,
      onDismiss: () => setSelectedRange(null),
    });
  }, [editor, hasOpenCommentForm, setSelectedRange]);
  const handleLineSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectedRange(range);
      if (range && onSelectionChange === undefined) {
        beginComment(range);
      }
    },
    [beginComment, onSelectionChange, setSelectedRange],
  );
  const handleGutterUtilityClick = useCallback(
    (range: SelectedLineRange) => {
      setSelectedRange(range);
      beginComment(range);
    },
    [beginComment, setSelectedRange],
  );

  const handlePostRender = useCallback<FilePostRender>(
    (fileContainer, instance, phase) => {
      onPostRender(fileContainer, instance, phase);

      if (selectionFrameRef.current !== null) {
        cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
      }
      if (phase === "unmount") {
        fileContainer.removeAttribute(FILE_ACTIVE_RANGE_ATTRIBUTE);
        return;
      }

      selectionFrameRef.current = requestAnimationFrame(() => {
        selectionFrameRef.current = null;
        if (!fileContainer.isConnected) return;
        const showsActiveRange = selectedRange === null && activeLineRange != null;
        fileContainer.toggleAttribute(FILE_ACTIVE_RANGE_ATTRIBUTE, showsActiveRange);
        instance.setSelectedLines(
          displayedRange,
          showsActiveRange
            ? { notify: false, activeLineSide: "additions", lineNumberOnly: false }
            : { notify: false },
        );
      });
    },
    [activeLineRange, displayedRange, onPostRender, selectedRange],
  );

  return (
    <DiffWorkerPoolProvider>
      <EditProvider editor={editor}>
        <div
          ref={surfaceRef}
          className="flex min-h-0 flex-1"
          onCompositionEnd={() =>
            queueMicrotask(() =>
              externalBindings.current.externalPersistence?.resumeExternalUpdates(),
            )
          }
          onKeyDownCapture={(event) => {
            if (
              onRunShortcut === undefined ||
              event.key !== "Enter" ||
              (!event.metaKey && !event.ctrlKey) ||
              event.altKey ||
              event.shiftKey
            ) {
              return;
            }
            event.preventDefault();
            onRunShortcut(editor.getState().selections?.at(-1) ?? null);
          }}
        >
          <Virtualizer
            className="file-preview-virtualizer min-h-0 flex-1 overflow-auto"
            config={{
              overscrollSize: 600,
              intersectionObserverMargin: 1200,
            }}
          >
            <File<FileCommentAnnotationGroup>
              file={{
                name: relativePath,
                contents,
                ...scientificSourceLanguageOverride(relativePath),
                cacheKey: projectFileEditorCacheKey(
                  environmentId,
                  cwd,
                  relativePath,
                  contents,
                  editor.getFile(),
                ),
              }}
              options={{
                disableFileHeader: true,
                enableGutterUtility: renderEditorGutterAction !== undefined || !hasOpenCommentForm,
                enableLineSelection: !hasOpenCommentForm,
                ...(renderEditorGutterAction === undefined
                  ? { onGutterUtilityClick: handleGutterUtilityClick }
                  : {}),
                onLineSelectionChange: setSelectedRange,
                onLineSelectionEnd: handleLineSelectionEnd,
                overflow: wordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                preferredHighlighter: PREFERRED_HIGHLIGHTER,
                themeType: resolvedTheme,
                unsafeCSS:
                  renderEditorGutterAction === undefined
                    ? FILE_LINK_REVEAL_UNSAFE_CSS
                    : FILE_EDITOR_ACTION_GUTTER_UNSAFE_CSS,
                onPostRender: handlePostRender,
              }}
              selectedLines={displayedRange}
              lineAnnotations={lineAnnotations}
              renderAnnotation={(annotation) => (
                <div className="py-1">
                  {annotation.metadata.entries.map((entry) => (
                    <DiffCommentAnnotation
                      key={entry.id}
                      kind={entry.kind}
                      rangeLabel={formatFileCommentRange(entry.startLine, entry.endLine)}
                      text={entry.text}
                      onCancel={() => removeAnnotationEntry(entry.id)}
                      onComment={(text) => submitAnnotationEntry(entry.id, text)}
                      onDelete={() => removeAnnotationEntry(entry.id)}
                    />
                  ))}
                </div>
              )}
              {...(renderEditorGutterAction === undefined
                ? {}
                : { renderGutterUtility: renderEditorGutterAction })}
              className="min-h-full"
              contentEditable={!editingBlocked}
            />
          </Virtualizer>
        </div>
      </EditProvider>
    </DiffWorkerPoolProvider>
  );
}

/** T3's ordinary rendered preview remains authoritative for MDX. */
function RenderedMarkdownSurface({
  environmentId,
  cwd,
  relativePath,
  contents,
  revision,
  truncated,
  readOnly,
  threadRef,
  onPendingChange,
  onSaveFailure,
  onSaveConfirmed,
  onSaveResolutionApplied,
  saveResolution,
}: Omit<
  EditableFileSurfaceProps,
  | "resolvedTheme"
  | "composerDraftTarget"
  | "revealLine"
  | "revealRequestId"
  | "wordWrap"
  | "onPostRender"
> & {
  truncated: boolean;
  readOnly: boolean;
  threadRef: ScopedThreadRef;
}) {
  const saveCoordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath,
    revision,
    onPendingChange,
    onSaveFailure,
    onSaveConfirmed,
    onSaveResolutionApplied,
    saveResolution,
  });

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        text={contents}
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        onTaskListChange={
          truncated || readOnly
            ? undefined
            : ({ markerOffset, checked }) => {
                const currentContents =
                  getOptimisticProjectFileQueryData(environmentId, cwd, relativePath)?.contents ??
                  contents;
                const nextContents = resolveMarkdownTaskPreviewUpdate({
                  markdown: currentContents,
                  markerOffset,
                  checked,
                  truncated,
                });
                if (nextContents === null) return;
                setProjectFileQueryData(environmentId, cwd, relativePath, nextContents);
                saveCoordinator.change(nextContents);
              }
        }
      />
    </ScrollArea>
  );
}

function renderedToggleLabel(isMarkdown: boolean, rendered: boolean): string {
  if (isMarkdown) return rendered ? "Show markdown source" : "Show rendered markdown";
  return rendered ? "Show HTML source" : "Show rendered page";
}

function initialExplorerOpen(): boolean {
  try {
    return resolveInitialFileExplorerOpen(
      getLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, Schema.Boolean),
    );
  } catch (error) {
    console.error(error);
    return resolveInitialFileExplorerOpen(null);
  }
}

export default function FilePreviewPanel({
  onCiteFile,
  fileCitation,
  environmentId,
  cwd,
  projectName,
  relativePath,
  attachment,
  threadRef,
  composerDraftTarget,
  keybindings,
  availableEditors,
  revealLine,
  revealRequestId,
  htmlPresentationRequest,
  latexPresentationRequest,
  onOpenFile,
  onOpenFileSource,
  onHtmlPresentationRequestHandled,
  onLatexPresentationRequestHandled,
  onPendingChange,
  selectedFilePending,
  workspaceMutationId,
}: FilePreviewPanelProps) {
  const { resolvedTheme } = useTheme();
  const wordWrap = useClientSettings((settings) => settings.wordWrap);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const remoteOpenState = useRemoteOpenState(environmentId);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const previewKind = resolveFilePreviewKind(relativePath);
  const isVideo = relativePath !== null && isWorkspaceVideoPreviewPath(relativePath);
  const isImage = previewKind === "image" && !isVideo;
  const isMedia = isImage || isVideo;
  const isPdf = previewKind === "pdf";
  const isHtml = relativePath !== null && !isPdf && isBrowserPreviewFile(relativePath);
  // Attachments and absolute host paths are preview-only and never enter the
  // workspace editor or explorer.
  const isHostFile =
    attachment !== undefined || (relativePath !== null && isAbsolutePath(relativePath));
  const [genericPendingPaths, setPendingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const {
    pendingSurfaceIds: pendingPaths,
    quietSurfaceIds: quietMarkdownPaths,
    departureOptions,
  } = useMarkdownPersistenceGuards({
    environmentId,
    cwd,
    idKind: "path",
    genericPendingIds: genericPendingPaths,
  });
  const sourcePending = relativePath !== null && pendingPaths.has(relativePath);
  const effectiveSourcePending = sourcePending || selectedFilePending;
  const runAfterPendingSave = usePendingSurfaceDeparture(pendingPaths, departureOptions);
  const [explorerOpen, setExplorerOpen] = useState(initialExplorerOpen);
  const [pdfExplorerOpen, setPdfExplorerOpen] = useState(false);
  const effectiveExplorerOpen = isPdf ? pdfExplorerOpen : explorerOpen;
  const showExplorer = shouldShowFileExplorer({
    relativePath,
    explorerOpen: effectiveExplorerOpen,
    attachmentOpen: attachment !== undefined,
  });
  // Reading markdown rendered is a preference, not a property of one file. Keeping
  // it on the panel meant a thread switch dropped it and forced source back.
  const [renderMarkdownPreferred, setRenderMarkdownPreferred] = useLocalStorage(
    RENDER_MARKDOWN_STORAGE_KEY,
    SCIENT_DEFAULT_RENDER_MARKDOWN,
    Schema.Boolean,
  );
  const [renderBrowserFilePreferred, setRenderBrowserFilePreferred] = useLocalStorage(
    RENDER_BROWSER_FILE_STORAGE_KEY,
    true,
    Schema.Boolean,
  );
  // A reveal still wins over the preference: the line only exists in the source.
  const [handledReveal, setHandledReveal] = useState<{ path: string; requestId: number } | null>(
    null,
  );
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const computeSourceLanguage =
    relativePath === null ? null : computeSourceLanguageForPath(relativePath);
  const computeContextId =
    relativePath === null || computeSourceLanguage === null
      ? null
      : computeFileContextId({
          environmentId,
          threadId: threadRef.threadId,
          cwd,
          relativePath,
        });
  const isMarkdownPreview = relativePath ? isMarkdownPreviewFile(relativePath) : false;
  const isRichMarkdown = relativePath ? isScientMarkdownDocumentPath(relativePath) : false;
  const isMarkdownDocument = isMarkdownPreview || isRichMarkdown;
  const revealHandled =
    revealLine === null ||
    (handledReveal?.path === relativePath && handledReveal.requestId === revealRequestId);
  const [dismissedCitationReveal, setDismissedCitationReveal] = useState<number | null>(null);
  const citationRevealActive =
    fileCitation !== undefined && dismissedCitationReveal !== revealRequestId;
  const renderMarkdown =
    isMarkdownDocument && (renderMarkdownPreferred || citationRevealActive) && revealHandled;
  const requestedHtmlMode =
    htmlPresentationRequest?.id === revealRequestId ? htmlPresentationRequest.mode : null;
  const renderBrowserFile =
    isHtml &&
    resolveHtmlRenderedState(renderBrowserFilePreferred, requestedHtmlMode) &&
    revealHandled;
  const canToggleRendered = isMarkdownDocument || isHtml;
  const rendered = isMarkdownDocument ? renderMarkdown : isHtml ? renderBrowserFile : false;
  const canToggleRenderedForSurface = attachment === undefined && canToggleRendered;
  const {
    automaticRefreshUnavailable,
    cancelReloadNotice,
    file: queriedFile,
    handleSaveConfirmed,
    handleSaveFailure,
    handleSaveResolutionApplied,
    reloadNotice,
    requestManualReload,
    requestOverwrite,
    requestRetrySave,
    resolveReloadNotice,
    saveError,
    saveResolution,
    saveRetryReady,
    viewerRefreshKey,
  } = useWorkspaceFileRefresh({
    environmentId,
    cwd,
    relativePath,
    loadAsText: attachment === undefined && shouldLoadFileAsText(relativePath),
    sourcePending: effectiveSourcePending,
    surfaceOwnsConflictDetection: isRichMarkdown && !isHostFile,
    workspaceMutationId,
    watchChanges:
      attachment === undefined && !isHostFile && !quietMarkdownPaths.has(relativePath ?? ""),
  });
  const {
    lease: markdownLease,
    snapshot: markdownSnapshot,
    admissionError,
    retryAdmission,
  } = useMarkdownPersistenceLease({
    target:
      isRichMarkdown && !isHostFile && relativePath !== null
        ? { environmentId, cwd, relativePath }
        : null,
    authoritativeSnapshot: queriedFile.authoritativeData,
    workspaceMutationId,
  });
  // Once admitted, the retained draft is the editor's display truth even when
  // an unrelated cached query fails or temporarily returns an older snapshot.
  const file =
    markdownSnapshot && relativePath !== null
      ? {
          ...queriedFile,
          error: null,
          isPending: false,
          data: {
            relativePath,
            contents: markdownSnapshot.draftSource,
            revision: markdownSnapshot.baselineRevision,
            byteLength: queriedFile.data?.byteLength ?? 0,
            truncated: false,
            readOnly: false,
          },
        }
      : queriedFile;
  const awaitingMarkdownLease =
    isRichMarkdown &&
    !isHostFile &&
    markdownLease === null &&
    queriedFile.authoritativeData !== null &&
    !queriedFile.authoritativeData.truncated &&
    !queriedFile.authoritativeData.readOnly;
  const usesScientMarkdownEditor =
    relativePath !== null &&
    markdownLease !== null &&
    file.data !== null &&
    shouldUseScientMarkdownEditor({
      path: relativePath,
      readOnly: false,
      renderMarkdown,
      truncated: false,
    });
  const handleRenderMarkdownChange = useCallback(
    (pressed: boolean) => {
      const apply = () => {
        setDismissedCitationReveal(revealRequestId);
        setRenderMarkdownPreferred(pressed);
        setHandledReveal(
          pressed && relativePath !== null
            ? { path: relativePath, requestId: revealRequestId }
            : null,
        );
      };
      if (relativePath === null) {
        apply();
        return;
      }
      runAfterPendingSave([relativePath], apply);
    },
    [relativePath, revealRequestId, runAfterPendingSave, setRenderMarkdownPreferred],
  );
  const handleRenderedChange = useCallback(
    (pressed: boolean) => {
      if (isMarkdownDocument) {
        handleRenderMarkdownChange(pressed);
        return;
      }
      if (!isHtml) return;
      if (relativePath !== null && htmlPresentationRequest !== null) {
        onHtmlPresentationRequestHandled(relativePath, htmlPresentationRequest);
      }
      setRenderBrowserFilePreferred(pressed);
      setHandledReveal(
        pressed && relativePath !== null
          ? { path: relativePath, requestId: revealRequestId }
          : null,
      );
    },
    [
      handleRenderMarkdownChange,
      htmlPresentationRequest,
      isHtml,
      isMarkdownDocument,
      onHtmlPresentationRequestHandled,
      relativePath,
      revealRequestId,
      setRenderBrowserFilePreferred,
    ],
  );
  const canOpenInBrowser =
    relativePath !== null &&
    attachment === undefined &&
    !isVideo &&
    isPreviewSupportedInRuntime() &&
    isBrowserPreviewFile(relativePath);
  const absolutePath =
    relativePath && attachment === undefined ? resolvePathLinkTarget(relativePath, cwd) : null;
  const pdfSource = useMemo(
    () =>
      workspacePdfSourceForPreview({
        absolutePath,
        environmentId,
        relativePath,
        threadId: threadRef.threadId,
        workspaceRoot: cwd,
      }),
    [absolutePath, cwd, environmentId, relativePath, threadRef.threadId],
  );
  const onFilePostRender = useFileLineReveal(relativePath, revealLine, revealRequestId);
  const handlePendingChange = useCallback(
    (path: string, pending: boolean) => {
      setPendingPaths((current) => {
        const next = new Set(current);
        if (pending) next.add(path);
        else next.delete(path);
        return next;
      });
      onPendingChange(path, pending);
    },
    [onPendingChange],
  );
  useEffect(() => {
    const currentCrumb = breadcrumbRef.current?.querySelector<HTMLElement>(
      "[data-current-file-crumb='true']",
    );
    currentCrumb?.scrollIntoView({ block: "nearest", inline: "end" });
  }, [relativePath]);

  const toggleExplorer = () => {
    if (isPdf) {
      setPdfExplorerOpen((current) => !current);
      return;
    }
    setExplorerOpen((current) => {
      const next = !current;
      try {
        setLocalStorageItem(FILE_EXPLORER_STORAGE_KEY, next, Schema.Boolean);
      } catch (error) {
        console.error(error);
      }
      return next;
    });
  };

  const handleOpenInBrowser = useCallback(() => {
    if (!absolutePath || !relativePath || !environmentHttpBaseUrl) return;
    void (async () => {
      const result = await openFileInPreview({
        threadRef,
        workspaceRoot: cwd,
        relativePath,
        filePath: absolutePath,
        httpBaseUrl: environmentHttpBaseUrl,
        createAssetUrl,
        openPreview,
      });
      if (result._tag === "Success" || isAtomCommandInterrupted(result)) {
        return;
      }
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Unable to open file in browser",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    })();
  }, [
    absolutePath,
    createAssetUrl,
    cwd,
    environmentHttpBaseUrl,
    openPreview,
    relativePath,
    threadRef,
  ]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {relativePath ? (
        <div
          className={cn(
            "flex h-10 min-h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-3 in-data-[preview-panel-mode=inline]:h-7 in-data-[preview-panel-mode=inline]:min-h-7 in-data-[preview-panel-mode=inline]:border-b-transparent",
            usesScientMarkdownEditor
              ? "in-data-[preview-panel-mode=inline]:mb-2"
              : "in-data-[preview-panel-mode=inline]:mb-3",
          )}
          data-surface-subheader
        >
          {attachment ? (
            <div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs">
              <PierreEntryIcon
                pathValue={attachment.name}
                kind="file"
                theme={resolvedTheme}
                className="size-3.5"
              />
              <span className="truncate font-medium">{attachment.name}</span>
            </div>
          ) : (
            <ScrollArea
              ref={breadcrumbRef}
              hideScrollbars
              scrollFade
              className="min-w-0 flex-1 rounded-none"
              data-file-breadcrumbs
            >
              {isHostFile ? (
                <FileBreadcrumbs
                  cwd={cwd}
                  environmentId={environmentId}
                  onOpenFile={onOpenFile}
                  projectName={projectName}
                  relativePath={relativePath}
                  workspaceMutationId={workspaceMutationId}
                />
              ) : (
                <FileBreadcrumbNavigator
                  environmentId={environmentId}
                  cwd={cwd}
                  projectName={projectName}
                  relativePath={relativePath}
                  onOpenFile={onOpenFile}
                  currentFileControl={
                    isRichMarkdown && !file.data?.readOnly ? (
                      <ScientMarkdownRenameButton
                        {...(markdownLease
                          ? { beforeRename: () => markdownLease.holdForRename() }
                          : {})}
                        environmentId={environmentId}
                        cwd={cwd}
                        relativePath={relativePath}
                        revision={
                          markdownSnapshot?.baselineRevision ?? file.data?.revision ?? "unavailable"
                        }
                        disabled={
                          effectiveSourcePending ||
                          file.data === null ||
                          (file.data?.truncated ?? false)
                        }
                        label={relativePath.slice(relativePath.lastIndexOf("/") + 1)}
                        onRenamed={(destinationRelativePath, revision) => {
                          markdownPersistenceRegistry.forgetClean({
                            environmentId,
                            cwd,
                            relativePath,
                          });
                          if (file.data) {
                            setProjectFileQueryData(
                              environmentId,
                              cwd,
                              destinationRelativePath,
                              file.data.contents,
                              revision,
                            );
                          }
                          clearProjectFileQueryData(environmentId, cwd, relativePath);
                          refreshProjectEntriesQuery(environmentId, cwd);
                          onOpenFile(destinationRelativePath);
                        }}
                      />
                    ) : undefined
                  }
                />
              )}
            </ScrollArea>
          )}
          {absolutePath &&
          (environmentId === primaryEnvironmentId || remoteOpenState.mode !== "local-exec") ? (
            <OpenInPicker
              environmentId={environmentId}
              keybindings={keybindings}
              availableEditors={availableEditors}
              openInCwd={absolutePath}
              compact
              enableShortcut={false}
            />
          ) : null}
          {canToggleRenderedForSurface ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={rendered}
                    onPressedChange={handleRenderedChange}
                    aria-label={renderedToggleLabel(isMarkdownDocument, rendered)}
                    variant="ghost"
                    size="sm"
                  >
                    {rendered ? <Code2 className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Toggle>
                }
              />
              <TooltipPopup>{renderedToggleLabel(isMarkdownDocument, rendered)}</TooltipPopup>
            </Tooltip>
          ) : null}
          {canOpenInBrowser ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={false}
                    onPressedChange={handleOpenInBrowser}
                    aria-label="Open file in preview browser"
                    variant="ghost"
                    size="sm"
                  >
                    <Globe2 className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>Open file in preview browser</TooltipPopup>
            </Tooltip>
          ) : null}
          {attachment === undefined ? (
            <ScientFileReloadButton
              automaticRefreshUnavailable={automaticRefreshUnavailable}
              isPending={markdownSnapshot?.reading ?? file.isPending}
              onReload={
                markdownLease
                  ? () => void markdownLease.refresh()
                  : admissionError
                    ? retryAdmission
                    : requestManualReload
              }
            />
          ) : null}
          {!isHostFile ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Toggle
                    className="shrink-0"
                    pressed={effectiveExplorerOpen}
                    onPressedChange={toggleExplorer}
                    aria-label={effectiveExplorerOpen ? "Hide file explorer" : "Show file explorer"}
                    variant="ghost"
                    size="sm"
                  >
                    <FolderTree className="size-3.5" />
                  </Toggle>
                }
              />
              <TooltipPopup>
                {effectiveExplorerOpen ? "Hide file explorer" : "Show file explorer"}
              </TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      ) : null}
      {markdownLease ? (
        <ScientMarkdownPersistenceNotice key={relativePath} persistence={markdownLease} />
      ) : (
        <ScientFileFreshnessNotices
          relativePath={relativePath}
          notice={reloadNotice}
          readError={file.error}
          saveError={saveError}
          saveRetryReady={saveRetryReady}
          hasFallbackData={file.data !== null}
          onCancel={cancelReloadNotice}
          onReload={requestManualReload}
          onRequestOverwrite={requestOverwrite}
          onRetrySave={requestRetrySave}
          onResolve={resolveReloadNotice}
        />
      )}
      {relativePath && !markdownLease && !isPdf && file.data?.readOnly ? (
        <div className="shrink-0 border-b border-border/50 bg-muted/35 px-3 py-1.5 text-[11px] text-muted-foreground">
          This file is read-only in Files.
        </div>
      ) : null}
      {relativePath && !markdownLease && !isMedia && !renderBrowserFile && file.data?.truncated ? (
        <div className="shrink-0 border-b border-warning/20 bg-warning-surface px-3 py-1.5 text-[11px] text-warning-foreground">
          Read-only preview limited to the first 1 MB of a {file.data.byteLength.toLocaleString()}{" "}
          byte file.
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "min-w-0 flex-1 flex-col overflow-hidden",
            relativePath ? "flex" : "hidden",
          )}
        >
          {relativePath && attachment ? (
            <AttachmentBrowserPreview environmentId={environmentId} attachment={attachment} />
          ) : relativePath && isVideo && absolutePath ? (
            <WorkspaceVideoPreview
              key={`${environmentId}:${threadRef.threadId}:${absolutePath}`}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              name={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isImage && absolutePath ? (
            <WorkspaceImagePreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              workspaceRoot={cwd}
              relativePath={relativePath}
              absolutePath={absolutePath}
              alt={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : relativePath && isPdf && absolutePath && pdfSource ? (
            <Suspense
              fallback={
                <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                  <Spinner className="size-5" />
                </div>
              }
            >
              <ScientPdfReader
                key={absolutePath}
                source={pdfSource}
                refreshKey={viewerRefreshKey}
              />
            </Suspense>
          ) : relativePath && renderBrowserFile && absolutePath ? (
            <WorkspaceBrowserPreview
              key={absolutePath}
              environmentId={environmentId}
              threadRef={threadRef}
              absolutePath={absolutePath}
              workspaceRoot={cwd}
              relativePath={relativePath}
              title={relativePath}
              refreshKey={viewerRefreshKey}
            />
          ) : awaitingMarkdownLease && admissionError ? (
            <>
              <div
                role="alert"
                className="shrink-0 border-b border-warning/24 bg-warning-surface px-3 py-2 text-xs text-warning-foreground"
              >
                <p>
                  This file could not be opened safely for editing. The last available preview is
                  read-only.
                </p>
                <p>
                  {admissionError instanceof Error
                    ? admissionError.message
                    : "The current disk version could not be verified."}
                </p>
                <Button size="xs" variant="outline" onClick={retryAdmission}>
                  Try again
                </Button>
              </div>
              {relativePath && file.data ? (
                <StaticTextFileSurface
                  cwd={cwd}
                  relativePath={relativePath}
                  contents={file.data.contents}
                  resolvedTheme={resolvedTheme}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                />
              ) : null}
            </>
          ) : awaitingMarkdownLease ? (
            <div
              className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"
              aria-label="Opening Markdown editor"
            />
          ) : relativePath && file.error && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs leading-relaxed text-destructive">
              {file.error}
            </div>
          ) : relativePath && file.data === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
              <Spinner className="size-5" />
            </div>
          ) : relativePath && file.data ? (
            file.data.readOnly && !markdownLease ? (
              isMarkdownDocument && renderMarkdown ? (
                <RenderedMarkdownSurface
                  key={relativePath}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  threadRef={threadRef}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  truncated={file.data.truncated}
                  readOnly
                  onPendingChange={handlePendingChange}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                />
              ) : (
                <StaticTextFileSurface
                  key={`${relativePath}:${resolvedTheme}:${file.data.revision}`}
                  cwd={cwd}
                  relativePath={relativePath}
                  contents={file.data.contents}
                  resolvedTheme={resolvedTheme}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                />
              )
            ) : isLatexPreviewFile(relativePath) ? (
              <Suspense
                fallback={
                  <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                    <Spinner className="size-5" />
                  </div>
                }
              >
                <ScientLatexSurface
                  key={`${relativePath}:${resolvedTheme}`}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  truncated={file.data.truncated}
                  resolvedTheme={resolvedTheme}
                  revealLine={revealLine}
                  revealRequestId={revealRequestId}
                  latexPresentationRequest={latexPresentationRequest}
                  wordWrap={wordWrap}
                  onPostRender={onFilePostRender}
                  onPendingChange={handlePendingChange}
                  onOpenFileSource={onOpenFileSource}
                  onLatexPresentationRequestHandled={onLatexPresentationRequestHandled}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                />
              </Suspense>
            ) : computeSourceLanguage !== null && !file.data.truncated ? (
              <Suspense
                fallback={
                  <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                    <Spinner className="size-5" />
                  </div>
                }
              >
                <ScientComputeFileSurface
                  key={`${computeContextId}:${resolvedTheme}`}
                  language={computeSourceLanguage}
                  environmentId={environmentId}
                  threadRef={threadRef}
                  contextId={computeContextId!}
                  cwd={cwd}
                  relativePath={relativePath}
                  composerDraftTarget={composerDraftTarget}
                  contents={file.data.contents}
                  revision={file.data.revision}
                  resolvedTheme={resolvedTheme}
                  revealRequestId={revealRequestId}
                  wordWrap={wordWrap}
                  sourcePending={
                    effectiveSourcePending ||
                    (file.authoritativeData !== null &&
                      file.data.contents !== file.authoritativeData.contents)
                  }
                  onPostRender={onFilePostRender}
                  onPendingChange={handlePendingChange}
                  onSaveFailure={handleSaveFailure}
                  onSaveConfirmed={handleSaveConfirmed}
                  onSaveResolutionApplied={handleSaveResolutionApplied}
                  saveResolution={saveResolution}
                />
              </Suspense>
            ) : usesScientMarkdownEditor && markdownLease ? (
              <Suspense
                fallback={
                  <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
                    <Spinner className="size-5" />
                  </div>
                }
              >
                <ScientMarkdownFileSurface
                  key={relativePath}
                  environmentId={environmentId}
                  cwd={cwd}
                  relativePath={relativePath}
                  threadRef={threadRef}
                  persistence={markdownLease}
                  {...(onCiteFile ? { onCite: onCiteFile } : {})}
                  citationReveal={citationRevealActive ? fileCitation : undefined}
                  citationRevealId={revealRequestId}
                  resolvedTheme={resolvedTheme}
                  onOpenFile={onOpenFile}
                  onOpenFileSource={(path, line) =>
                    runAfterPendingSave([relativePath], () => onOpenFileSource(path, line))
                  }
                />
              </Suspense>
            ) : markdownLease ? (
              <MarkdownSourceSurface
                key={relativePath}
                persistence={markdownLease}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : isMarkdownDocument && renderMarkdown ? (
              <RenderedMarkdownSurface
                key={relativePath}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                threadRef={threadRef}
                contents={file.data.contents}
                revision={file.data.revision}
                truncated={file.data.truncated}
                readOnly={false}
                onPendingChange={handlePendingChange}
                onSaveFailure={handleSaveFailure}
                onSaveConfirmed={handleSaveConfirmed}
                onSaveResolutionApplied={handleSaveResolutionApplied}
                saveResolution={saveResolution}
              />
            ) : file.data.truncated ? (
              <StaticTextFileSurface
                key={`${relativePath}:${resolvedTheme}:${file.data.revision}`}
                cwd={cwd}
                relativePath={relativePath}
                contents={file.data.contents}
                resolvedTheme={resolvedTheme}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
              />
            ) : (
              <EditableFileSurface
                key={`${relativePath}:${resolvedTheme}`}
                environmentId={environmentId}
                cwd={cwd}
                relativePath={relativePath}
                composerDraftTarget={composerDraftTarget}
                contents={file.data.contents}
                revision={file.data.revision}
                resolvedTheme={resolvedTheme}
                revealRequestId={revealRequestId}
                wordWrap={wordWrap}
                onPostRender={onFilePostRender}
                onPendingChange={handlePendingChange}
                onSaveFailure={handleSaveFailure}
                onSaveConfirmed={handleSaveConfirmed}
                onSaveResolutionApplied={handleSaveResolutionApplied}
                saveResolution={saveResolution}
              />
            )
          ) : null}
          <ScientFileAuxiliarySurface
            environmentId={environmentId}
            threadRef={threadRef}
            cwd={cwd}
            relativePath={relativePath}
            sourceRevision={file.data?.revision ?? null}
            sourcePending={
              sourcePending ||
              (file.data !== null &&
                file.authoritativeData !== null &&
                file.data.contents !== file.authoritativeData.contents)
            }
            truncated={file.data?.truncated ?? false}
          />
        </div>
        {showExplorer ? (
          <aside
            className={cn(
              "flex min-h-0 shrink-0 bg-background",
              relativePath
                ? "w-[min(22rem,46%)] min-w-64 border-l border-border/60"
                : "min-w-0 flex-1",
            )}
          >
            <FileBrowserPanel
              key={`${environmentId}:${cwd}`}
              environmentId={environmentId}
              cwd={cwd}
              projectName={projectName}
              selectedPath={relativePath}
              selectedPathRevealId={revealRequestId}
              onOpenFile={onOpenFile}
              onOpenFileSource={onOpenFileSource}
              workspaceMutationId={workspaceMutationId}
              {...(relativePath && !isMedia && !isPdf
                ? { onRefreshSelectedFile: file.refresh }
                : {})}
            />
          </aside>
        ) : null}
      </div>
    </div>
  );
}
