import { RefreshIcon } from "~/components/ui/refresh-icon";
import type {
  ContextMenuItem as TreeContextMenuItem,
  ContextMenuOpenContext as TreeContextMenuOpenContext,
} from "@pierre/trees";
import type {
  EnvironmentId,
  ProjectDirectoryEntry,
  ProjectDirectoryView,
} from "@t3tools/contracts";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelector } from "@pierre/trees/react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { ChevronsDownUpIcon, ChevronsUpDownIcon, MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "~/lib/utils";

import { Button } from "~/components/ui/button";
import { InputGroup, InputGroupInput } from "~/components/ui/input-group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "~/components/ui/menu";
import { toastManager } from "~/components/ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useComposerHandleContext } from "~/composerHandleContext";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { readLocalApi } from "~/localApi";
import { T3_PIERRE_ICONS } from "~/pierre-icons";
import { shouldOpenInBrowserByDefault } from "~/scient/fileOpening/fileOpeningPolicy";
import { ScientMarkdownCreateButton } from "~/scient/markdownEditor/ui/ScientMarkdownCreateButton";
import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "~/scient/files/LazyWorkspaceTreeController";
import { projectEnvironment } from "~/state/projects";
import { useProjectPathSearch } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";
import { PIERRE_TREE_UNSAFE_CSS, pierreTreeStyle } from "~/pierre-tree-theme";

import { createFileTreeDragMentionController } from "./fileTreeDragMention";
import { areAllDirectoriesExpanded, setAllDirectoriesExpanded } from "./fileTreeExpansion";
import {
  refreshProjectEntriesQuery,
  setProjectFileQueryData,
  subscribeProjectFilesRefresh,
} from "./projectFilesQueryState";

interface FileBrowserPanelProps {
  environmentId: EnvironmentId;
  cwd: string;
  projectName: string;
  /** File currently open in the preview pane; revealed and selected in the tree. */
  selectedPath: string | null;
  /** Bumped when the same path should be revealed again (e.g. re-opened from search). */
  selectedPathRevealId: number;
  onOpenFile: (relativePath: string) => void;
  onOpenFileSource: (relativePath: string) => void;
  onRefreshSelectedFile?: () => void;
  workspaceMutationId: string | null;
}

const FILE_BROWSER_TREE_UNSAFE_CSS = `${PIERRE_TREE_UNSAFE_CSS}
  :host {
    --trees-font-size-override: var(--scient-font-size-file-tree, 14px);
  }
`;

const INITIAL_TREE_SNAPSHOT: LazyWorkspaceTreeSnapshot = {
  entries: new Map(),
  failures: [],
  isPending: true,
  rootError: null,
};

const FILE_SEARCH_LIMIT = 200;
const DIRECTORY_VIEW_BY_WORKSPACE = new Map<string, ProjectDirectoryView>();
const FILE_VISIBILITY_OPTIONS = [
  { value: "ordinary", label: "Project files" },
  { value: "with-internals", label: "All workspace internals" },
] as const satisfies ReadonlyArray<{ value: ProjectDirectoryView; label: string }>;

function RefreshFilesButton(props: { isPending: boolean; onRefresh: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Refresh workspace files"
            onClick={props.onRefresh}
          />
        }
      >
        <RefreshIcon refreshing={props.isPending} />
      </TooltipTrigger>
      <TooltipPopup>{props.isPending ? "Refreshing…" : "Refresh files"}</TooltipPopup>
    </Tooltip>
  );
}

function WorkspaceFilesMenu(props: {
  view: ProjectDirectoryView;
  onViewChange: (view: ProjectDirectoryView) => void;
}) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button type="button" variant="ghost" size="icon-xs" aria-label="Files menu" />
              }
            />
          }
        >
          <MoreHorizontal />
        </TooltipTrigger>
        <TooltipPopup>Files menu</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" sideOffset={6} className="min-w-56">
        <MenuGroup>
          <MenuGroupLabel>File visibility</MenuGroupLabel>
          <MenuRadioGroup
            value={props.view}
            onValueChange={(value) => props.onViewChange(value as ProjectDirectoryView)}
          >
            {FILE_VISIBILITY_OPTIONS.map((option) => (
              <MenuRadioItem
                key={option.value}
                value={option.value}
                className="data-highlighted:bg-primary/8 data-highlighted:text-foreground"
              >
                {option.label}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function FileSearchField(props: {
  ariaLabel: string;
  name: string;
  onClose: () => void;
  onValueChange: (value: string) => void;
  value: string;
}) {
  return (
    <InputGroup
      variant="ghost"
      className="h-7 min-w-0 flex-1 has-[input:focus-visible,textarea:focus-visible]:border-ring has-[input:focus-visible,textarea:focus-visible]:ring-0"
    >
      <InputGroupInput
        type="search"
        name={props.name}
        size="sm"
        value={props.value}
        aria-label={props.ariaLabel}
        placeholder="Search files"
        spellCheck={false}
        onChange={(event) => props.onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          props.onClose();
          event.currentTarget.blur();
        }}
      />
    </InputGroup>
  );
}

export default function FileBrowserPanel({
  environmentId,
  cwd,
  projectName,
  selectedPath,
  selectedPathRevealId,
  onOpenFile,
  onOpenFileSource,
  onRefreshSelectedFile,
  workspaceMutationId,
}: FileBrowserPanelProps) {
  const { resolvedTheme } = useTheme();
  const composerRef = useComposerHandleContext();
  const runListDirectory = useAtomCommand(projectEnvironment.listDirectory, {
    reportDefect: false,
    reportFailure: false,
  });
  const [treeSnapshot, setTreeSnapshot] =
    useState<LazyWorkspaceTreeSnapshot>(INITIAL_TREE_SNAPSHOT);
  const workspaceSessionKey = JSON.stringify([environmentId, cwd]);
  const [directoryView, setDirectoryView] = useState<ProjectDirectoryView>(
    () => DIRECTORY_VIEW_BY_WORKSPACE.get(workspaceSessionKey) ?? "ordinary",
  );
  const directoryViewRef = useRef(directoryView);
  directoryViewRef.current = directoryView;
  const [searchValue, setSearchValue] = useState("");
  const [primedSearchKey, setPrimedSearchKey] = useState<string | null>(null);
  const normalizedSearchValue = searchValue.trim();
  const isSearching = normalizedSearchValue.length > 0;
  const pathSearch = useProjectPathSearch(
    { environmentId, cwd, query: searchValue },
    FILE_SEARCH_LIMIT,
  );
  const hasCurrentSearch = pathSearch.searchedQuery === normalizedSearchValue;
  const searchResultKey =
    hasCurrentSearch && !pathSearch.isPending
      ? JSON.stringify([directoryView, normalizedSearchValue, pathSearch.entries])
      : null;
  const entryKinds = useMemo(
    () =>
      new Map(
        [...treeSnapshot.entries.values()].map(
          (entry) => [entry.relativePath, entry.kind] as const,
        ),
      ),
    [treeSnapshot.entries],
  );
  const loadedDirectoryPaths = useMemo(
    () =>
      [...treeSnapshot.entries.values()]
        .filter((entry) => entry.kind === "directory")
        .map((entry) => `${entry.relativePath}/`),
    [treeSnapshot.entries],
  );
  const entryKindsRef = useRef<ReadonlyMap<string, ProjectDirectoryEntry["kind"]>>(entryKinds);
  entryKindsRef.current = entryKinds;
  const treeEntriesRef = useRef(treeSnapshot.entries);
  treeEntriesRef.current = treeSnapshot.entries;
  const treeControllerRef = useRef<LazyWorkspaceTreeController | null>(null);
  const syncingSelectionRef = useRef(false);
  const treeSelectionPathRef = useRef<string | null>(null);
  const searchSelectionPathRef = useRef<string | null>(null);
  const handledRevealRef = useRef<{ path: string; revealId: number } | null>(null);

  // The tree renders rows in shadow DOM and its anchor rect is unreliable, so
  // capture the right-click position ourselves; contextmenu is a composed
  // event, so a capture-phase listener sees it with viewport coordinates.
  const contextMenuPointerRef = useRef<{ x: number; y: number; at: number } | null>(null);
  useEffect(() => {
    const capturePointer = (event: MouseEvent) => {
      contextMenuPointerRef.current = { x: event.clientX, y: event.clientY, at: event.timeStamp };
    };
    document.addEventListener("contextmenu", capturePointer, true);
    return () => document.removeEventListener("contextmenu", capturePointer, true);
  }, []);

  const showEntryContextMenu = async (
    item: TreeContextMenuItem,
    context: TreeContextMenuOpenContext,
  ) => {
    const api = readLocalApi();
    if (!api) {
      context.close();
      return;
    }
    const relativePath = item.path.replace(/\/$/, "");
    const mention = serializeComposerFileLink(relativePath);
    const pointer = contextMenuPointerRef.current;
    const pointerIsFresh = pointer !== null && performance.now() - pointer.at < 1000;
    const anchorRect = context.anchorElement.getBoundingClientRect();
    const position = pointerIsFresh
      ? { x: pointer.x, y: pointer.y }
      : { x: anchorRect.left, y: anchorRect.bottom };
    try {
      const clicked = await api.contextMenu.show(
        [
          ...(shouldOpenInBrowserByDefault(relativePath)
            ? ([{ id: "open-source", label: "Open source" }] as const)
            : []),
          { id: "copy-mention", label: "Copy mention" },
          { id: "add-to-chat", label: "Add to chat" },
        ],
        position,
      );
      if (clicked === "open-source") {
        onOpenFileSource(relativePath);
        return;
      }
      if (clicked === "copy-mention") {
        try {
          await writeTextToClipboard(mention);
          toastManager.add({ type: "success", title: "Mention copied", description: relativePath });
        } catch (error) {
          toastManager.add({
            type: "error",
            title: "Failed to copy mention",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
        return;
      }
      if (clicked === "add-to-chat") {
        const composer = composerRef?.current;
        if (!composer) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "Open a chat for this project and try again.",
          });
          return;
        }
        const inserted = composer.insertTextAtEnd(`${mention} `, { ensureLeadingBoundary: true });
        if (!inserted) {
          toastManager.add({
            type: "error",
            title: "Unable to add to chat",
            description: "The chat isn't ready to accept input right now.",
          });
        }
      }
    } finally {
      context.close();
    }
  };
  const showEntryContextMenuRef = useRef(showEntryContextMenu);
  useEffect(() => {
    showEntryContextMenuRef.current = showEntryContextMenu;
  });

  const treeModelRef = useRef<ReturnType<typeof useFileTree>["model"] | null>(null);
  const dragMention = useMemo(
    () =>
      createFileTreeDragMentionController({
        deselect: (path) => treeModelRef.current?.getItem(path)?.deselect(),
      }),
    [],
  );
  const { model } = useFileTree({
    composition: {
      contextMenu: {
        triggerMode: "right-click",
        onOpen: (item, context) => {
          void showEntryContextMenuRef.current(item, context);
        },
      },
    },
    // Rows only need to be draggable so entries can be dropped into the chat
    // composer; rearranging files inside the tree stays off.
    dragAndDrop: { canDrop: () => false },
    density: "compact",
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
    icons: T3_PIERRE_ICONS,
    onSelectionChange: (selectedPaths) => {
      // The drag controller's selection cache must track every change,
      // including reveal-driven ones, or drags act on a stale selection.
      dragMention.handleSelectionChange(selectedPaths);
      // Selection changes driven by the reveal sync below are echoes of an
      // already-open file, not a request to open it again.
      if (syncingSelectionRef.current) return;
      // Starting a drag selects the dragged row; that selection is a side
      // effect of the gesture, not a request to open the file.
      if (dragMention.isDragInProgress()) {
        return;
      }
      const selectedPath = selectedPaths.at(-1)?.replace(/\/$/, "");
      if (selectedPath && entryKindsRef.current.get(selectedPath) !== "directory") {
        treeSelectionPathRef.current = selectedPath;
        onOpenFile(selectedPath);
      }
    },
    paths: [],
    renderRowDecoration: ({ item }) => {
      const relativePath = item.path.replace(/\/$/, "");
      return treeEntriesRef.current.get(relativePath)?.readOnly
        ? { icon: "file-tree-icon-lock", title: "Read-only in Files" }
        : null;
    },
    search: false,
    unsafeCSS: FILE_BROWSER_TREE_UNSAFE_CSS,
  });
  const treeSearch = useFileTreeSearch(model);
  const allLoadedDirectoriesExpanded = useFileTreeSelector(model, (currentModel) =>
    areAllDirectoriesExpanded(currentModel, loadedDirectoryPaths),
  );
  const toggleLoadedDirectories = () => {
    setAllDirectoriesExpanded(model, loadedDirectoryPaths, !allLoadedDirectoriesExpanded);
  };
  const loadDirectory = useCallback(
    async (relativeDirectory: string, view: ProjectDirectoryView) => {
      const result = await runListDirectory({
        environmentId,
        input: { cwd, relativeDirectory, view },
      });
      if (result._tag === "Success") return result.value;
      throw squashAtomCommandFailure(result);
    },
    [cwd, environmentId, runListDirectory],
  );

  useEffect(() => {
    setTreeSnapshot(INITIAL_TREE_SNAPSHOT);
    const controller = new LazyWorkspaceTreeController({
      model,
      loadDirectory,
      initialView: directoryViewRef.current,
      onSnapshot: (snapshot) => {
        treeEntriesRef.current = snapshot.entries;
        setTreeSnapshot(snapshot);
      },
    });
    treeControllerRef.current = controller;
    void controller.start();
    return () => {
      controller.destroy();
      if (treeControllerRef.current === controller) treeControllerRef.current = null;
    };
  }, [loadDirectory, model]);

  useEffect(() => {
    void treeControllerRef.current?.setView(directoryView);
  }, [directoryView]);

  useEffect(() => {
    if (!isSearching || searchResultKey === null) return;
    if (pathSearch.entries.length === 0) {
      setPrimedSearchKey(searchResultKey);
      return;
    }

    const controller = treeControllerRef.current;
    if (!controller) return;
    let cancelled = false;
    void controller.primePaths(pathSearch.entries.map((entry) => entry.path)).finally(() => {
      if (cancelled || treeControllerRef.current !== controller) return;
      setPrimedSearchKey(searchResultKey);
    });
    return () => {
      cancelled = true;
    };
  }, [isSearching, pathSearch.entries, searchResultKey]);

  const handleSearchValueChange = (value: string) => {
    if (!isSearching && value.trim().length > 0) {
      // Starting a search must not look like an external file selection.
      // Keep the file that was already open as this search session's anchor.
      searchSelectionPathRef.current = selectedPath;
    }
    if (value.trim().length === 0) {
      if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
      searchSelectionPathRef.current = null;
      model.closeSearch();
    } else {
      model.setSearch(value);
    }
    setSearchValue(value);
  };
  const handleSearchClose = () => {
    if (searchSelectionPathRef.current === selectedPath) handledRevealRef.current = null;
    searchSelectionPathRef.current = null;
    model.closeSearch();
    setSearchValue("");
  };
  const refreshEntries = useCallback(() => {
    void treeControllerRef.current?.refresh();
    refreshProjectEntriesQuery(environmentId, cwd);
    if (isSearching) pathSearch.refresh();
  }, [cwd, environmentId, isSearching, pathSearch.refresh]);
  useWorkspaceMutationRefresh({
    mutationId: workspaceMutationId,
    refresh: refreshEntries,
    resourceKey: `files:${environmentId}:${cwd}`,
  });
  const handleRefresh = () => {
    refreshEntries();
    onRefreshSelectedFile?.();
  };

  useEffect(
    () => subscribeProjectFilesRefresh(environmentId, cwd, refreshEntries),
    [environmentId, cwd, refreshEntries],
  );

  useEffect(() => {
    if (!selectedPath) {
      handledRevealRef.current = null;
      return;
    }
    const revealRequest = { path: selectedPath, revealId: selectedPathRevealId };
    if (isSearching) {
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        searchSelectionPathRef.current = selectedPath;
        handledRevealRef.current = revealRequest;
      } else if (searchSelectionPathRef.current === selectedPath) {
        handledRevealRef.current = revealRequest;
      } else {
        searchSelectionPathRef.current = null;
        model.closeSearch();
        setSearchValue("");
      }
      return;
    }
    const handledReveal = handledRevealRef.current;
    // Branch refreshes update entry metadata while the same preview stays open.
    // Replaying a handled reveal would steal focus from the user's current work.
    if (
      handledReveal?.path === revealRequest.path &&
      handledReveal.revealId === revealRequest.revealId
    ) {
      return;
    }
    let cancelled = false;
    void treeControllerRef.current?.ensurePath(selectedPath).then((found) => {
      if (cancelled || !found) return;
      const selectedItem = model.getItem(selectedPath);
      if (!selectedItem || entryKindsRef.current.get(selectedPath) === "directory") return;

      // A selection that originated inside the tree is already visible. Only
      // external opens (search, chat links, or another picker) need revealing.
      const selectedInTree = model
        .getSelectedPaths()
        .some((path) => path.replace(/\/$/, "") === selectedPath);
      if (selectedInTree && treeSelectionPathRef.current === selectedPath) {
        treeSelectionPathRef.current = null;
        handledRevealRef.current = revealRequest;
        return;
      }
      treeSelectionPathRef.current = null;
      handledRevealRef.current = revealRequest;

      syncingSelectionRef.current = true;
      for (const path of model.getSelectedPaths()) {
        model.getItem(path)?.deselect();
      }
      selectedItem.select();
      model.scrollToPath(selectedPath, { focus: true, offset: "center" });
      queueMicrotask(() => {
        syncingSelectionRef.current = false;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [isSearching, model, selectedPath, selectedPathRevealId]);

  // Tag tree drags with the composer mention payload. The row is read from
  // the composed event path (the tree's shadow root is open), so this does
  // not depend on running after the tree's own dragstart handler; the drag
  // data store is writable for every dragstart listener in the dispatch.
  // The capture phase runs before the tree's own dragstart handler selects
  // the dragged row, so the drag flag is up before that selection emits.
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    treeModelRef.current = model;
  }, [model]);
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) {
      return;
    }
    const handleDragStart = (event: DragEvent) => dragMention.handleDragStart(event);
    const handleDragEnd = () => dragMention.handleDragEnd();
    panel.addEventListener("dragstart", handleDragStart, true);
    panel.addEventListener("dragend", handleDragEnd);
    return () => {
      panel.removeEventListener("dragstart", handleDragStart, true);
      panel.removeEventListener("dragend", handleDragEnd);
    };
  }, [dragMention]);

  const isSearchPending =
    isSearching &&
    (!hasCurrentSearch || pathSearch.isPending || searchResultKey !== primedSearchKey);
  const currentSearchError = hasCurrentSearch ? pathSearch.error : null;
  const hideTreeForSearch = isSearching && treeSearch.matchingPaths.length === 0;
  const searchEmptyMessage = isSearchPending
    ? "Searching…"
    : currentSearchError
      ? "Couldn’t search unopened folders."
      : `No files or folders match “${normalizedSearchValue}”.`;

  return (
    <div
      ref={panelRef}
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-file-browser-panel={`${environmentId}:${cwd}`}
    >
      <div
        className="flex h-10 min-h-10 shrink-0 items-center gap-1 border-b border-border/60 bg-background px-2 in-data-[preview-panel-mode=inline]:mb-2 in-data-[preview-panel-mode=inline]:h-8 in-data-[preview-panel-mode=inline]:min-h-8 in-data-[preview-panel-mode=inline]:border-b-transparent in-data-[preview-panel-mode=inline]:pt-1"
        data-surface-subheader
      >
        <RefreshFilesButton
          isPending={treeSnapshot.isPending || isSearchPending}
          onRefresh={handleRefresh}
        />
        <ScientMarkdownCreateButton
          environmentId={environmentId}
          cwd={cwd}
          selectedPath={selectedPath}
          onCreated={(relativePath, contents, revision) => {
            setProjectFileQueryData(environmentId, cwd, relativePath, contents, revision);
            handleRefresh();
            onOpenFile(relativePath);
          }}
        />
        <FileSearchField
          name="project-files-search"
          ariaLabel={`Search ${projectName} files`}
          value={searchValue}
          onValueChange={handleSearchValueChange}
          onClose={handleSearchClose}
        />
        {loadedDirectoryPaths.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label={
                    allLoadedDirectoriesExpanded
                      ? "Collapse loaded folders"
                      : "Expand loaded folders"
                  }
                  onClick={toggleLoadedDirectories}
                />
              }
            >
              {allLoadedDirectoriesExpanded ? (
                <ChevronsDownUpIcon className="size-3.5" />
              ) : (
                <ChevronsUpDownIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup>
              {allLoadedDirectoriesExpanded ? "Collapse loaded folders" : "Expand loaded folders"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <WorkspaceFilesMenu
          view={directoryView}
          onViewChange={(nextView) => {
            if (nextView === "ordinary") {
              DIRECTORY_VIEW_BY_WORKSPACE.delete(workspaceSessionKey);
            } else {
              DIRECTORY_VIEW_BY_WORKSPACE.set(workspaceSessionKey, nextView);
            }
            setDirectoryView(nextView);
          }}
        />
      </div>
      <div className="sr-only" aria-live="polite">
        {isSearching
          ? isSearchPending
            ? "Searching workspace files."
            : currentSearchError
              ? "Some workspace files could not be searched."
              : `${treeSearch.matchingPaths.length} matching workspace paths.`
          : treeSnapshot.isPending
            ? "Loading workspace files."
            : treeSnapshot.failures.length > 0
              ? "Some workspace files could not be loaded."
              : "Workspace files loaded."}
      </div>
      {treeSnapshot.rootError && treeSnapshot.entries.size === 0 ? (
        <div className="flex flex-col items-start gap-2 p-4 text-xs leading-relaxed text-destructive">
          <span>{treeSnapshot.rootError}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-foreground"
            onClick={() => void treeControllerRef.current?.retry("")}
          >
            Retry
          </Button>
        </div>
      ) : (
        <div
          className="flex min-h-0 flex-1 flex-col"
          aria-busy={treeSnapshot.isPending || isSearchPending}
        >
          {treeSnapshot.failures[0] ? (
            <button
              type="button"
              className="shrink-0 border-b border-destructive/15 px-3 py-1.5 text-left text-[11px] leading-4 text-destructive transition-colors hover:bg-destructive/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              onClick={() =>
                void treeControllerRef.current?.retry(
                  treeSnapshot.failures[0]?.relativeDirectory ?? "",
                )
              }
            >
              Couldn’t load {treeSnapshot.failures[0].relativeDirectory || "the workspace"}. Retry
            </button>
          ) : treeSnapshot.entries.size === 0 && treeSnapshot.isPending ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">Loading files…</div>
          ) : null}
          <div className="relative flex min-h-0 flex-1">
            <FileTree
              model={model}
              aria-label={`${projectName} files`}
              className={cn("min-h-0 flex-1 overflow-hidden", hideTreeForSearch && "invisible")}
              style={pierreTreeStyle(resolvedTheme)}
            />
            {hideTreeForSearch ? (
              <div className="absolute inset-x-0 top-0 px-3 py-2 text-xs text-muted-foreground">
                {searchEmptyMessage}
              </div>
            ) : null}
          </div>
          {isSearching ? (
            <div className="shrink-0 border-t border-border/50 px-3 py-1.5 text-[11px] leading-4 text-muted-foreground">
              {isSearchPending
                ? "Searching unopened folders…"
                : currentSearchError
                  ? "Couldn’t search unopened folders. Loaded folders are still filtered."
                  : hasCurrentSearch && pathSearch.truncated
                    ? `First ${FILE_SEARCH_LIMIT} indexed matches loaded; ignored paths may not appear.`
                    : "Unopened folders use indexed search; ignored paths may not appear."}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
