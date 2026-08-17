import type { EnvironmentId } from "@t3tools/contracts";
import { Check, ChevronLeft, ChevronRight, LoaderCircle, RotateCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";

import {
  buildFileBreadcrumbEntryIndex,
  fileBreadcrumbBackTarget,
  fileBreadcrumbDirectoryLabel,
  resolveFileBreadcrumbPickerListing,
} from "./fileBreadcrumbPicker";
import { fileBreadcrumbs, type FileBreadcrumb } from "./filePath";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBreadcrumbNavigatorProps {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly relativePath: string;
  readonly onOpenFile: (relativePath: string) => void;
}

function crumbBrowseLabel(crumb: FileBreadcrumb, projectName: string): string {
  return crumb.kind === "project" ? `Browse ${projectName}` : `Browse ${crumb.path}`;
}

function PickerStatus(props: {
  readonly kind: "loading" | "error" | "message";
  readonly message: string;
  readonly onRetry?: () => void;
}) {
  return (
    <>
      <div
        className="flex min-h-8 items-center gap-2 px-2 py-1 text-muted-foreground text-xs"
        role="status"
      >
        {props.kind === "loading" ? (
          <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin" />
        ) : null}
        <span>{props.message}</span>
      </div>
      {props.kind === "error" && props.onRetry ? (
        <MenuItem closeOnClick={false} onClick={props.onRetry}>
          <RotateCw />
          Try again
        </MenuItem>
      ) : null}
    </>
  );
}

function FileBreadcrumbPickerMenu(props: {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectName: string;
  readonly initialDirectoryPath: string;
  readonly selectedFilePath: string;
  readonly onOpenFile: (relativePath: string) => void;
  readonly onRequestClose: () => void;
}) {
  const [directoryPath, setDirectoryPath] = useState(props.initialDirectoryPath);
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.cwd);
  const index = useMemo(
    () =>
      entriesQuery.data === null ? null : buildFileBreadcrumbEntryIndex(entriesQuery.data.entries),
    [entriesQuery.data],
  );
  const listing = resolveFileBreadcrumbPickerListing({
    index,
    directoryPath,
    error: entriesQuery.error,
    truncated: entriesQuery.data?.truncated ?? false,
  });
  const backTarget = fileBreadcrumbBackTarget(props.initialDirectoryPath, directoryPath);
  const directoryLabel = fileBreadcrumbDirectoryLabel(directoryPath, props.projectName);
  const { resolvedTheme } = useTheme();

  return (
    <MenuPopup
      align="start"
      aria-label={`${directoryLabel} contents`}
      className="w-72 max-w-[calc(100vw-1rem)]"
      side="bottom"
      sideOffset={6}
    >
      <MenuGroup>
        <MenuGroupLabel
          className="flex min-w-0 items-center gap-1.5"
          title={directoryPath || props.cwd}
        >
          <span className="truncate">{directoryLabel}</span>
        </MenuGroupLabel>
        {backTarget !== null ? (
          <>
            <MenuItem closeOnClick={false} onClick={() => setDirectoryPath(backTarget)}>
              <ChevronLeft />
              Back
            </MenuItem>
            <MenuSeparator />
          </>
        ) : null}
        {listing.state === "loading" ? (
          <PickerStatus kind="loading" message="Loading workspace files…" />
        ) : listing.state === "error" ? (
          <PickerStatus kind="error" message={listing.message} onRetry={entriesQuery.refresh} />
        ) : (
          <>
            {listing.entries.map((entry) => {
              const currentFile = entry.kind === "file" && entry.path === props.selectedFilePath;
              return (
                <MenuItem
                  key={entry.path}
                  closeOnClick={entry.kind === "file"}
                  data-current-file={currentFile}
                  className="data-[current-file=true]:bg-accent/60"
                  onClick={() => {
                    if (entry.kind === "directory") {
                      setDirectoryPath(entry.path);
                      return;
                    }
                    props.onRequestClose();
                    props.onOpenFile(entry.path);
                  }}
                >
                  <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={resolvedTheme} />
                  <span className="min-w-0 flex-1 truncate" title={entry.path}>
                    {entry.label}
                  </span>
                  {entry.kind === "directory" ? (
                    <ChevronRight aria-hidden className="ms-auto" />
                  ) : currentFile ? (
                    <Check aria-label="Current file" className="ms-auto" />
                  ) : null}
                </MenuItem>
              );
            })}
            {listing.message ? <PickerStatus kind="message" message={listing.message} /> : null}
          </>
        )}
      </MenuGroup>
    </MenuPopup>
  );
}

export function FileBreadcrumbNavigator({
  environmentId,
  cwd,
  projectName,
  relativePath,
  onOpenFile,
}: FileBreadcrumbNavigatorProps) {
  const [openCrumbPath, setOpenCrumbPath] = useState<string | null>(null);
  const breadcrumbs = useMemo(
    () => fileBreadcrumbs(projectName, relativePath),
    [projectName, relativePath],
  );

  useEffect(() => {
    setOpenCrumbPath(null);
  }, [relativePath]);

  return (
    <div className="flex h-full w-max min-w-full items-center text-xs">
      {breadcrumbs.map((crumb, index) => {
        const currentFile = crumb.kind === "file";
        return (
          <div
            key={crumb.path || "project"}
            className="flex min-w-0 shrink-0 items-center"
            data-current-file-crumb={currentFile}
            data-file-breadcrumb-kind={crumb.kind}
          >
            {index > 0 ? (
              <ChevronRight className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
            ) : null}
            {currentFile ? (
              <span className="max-w-40 truncate font-medium text-foreground" title={crumb.path}>
                {crumb.label}
              </span>
            ) : (
              <Menu
                open={openCrumbPath === crumb.path}
                onOpenChange={(open) => setOpenCrumbPath(open ? crumb.path : null)}
              >
                <MenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={crumbBrowseLabel(crumb, projectName)}
                      className={cn(
                        "-mx-1 max-w-40 cursor-pointer truncate rounded-sm px-1 py-0.5 text-muted-foreground outline-none",
                        "hover:bg-accent/60 hover:text-foreground data-popup-open:bg-accent/60 data-popup-open:text-foreground",
                        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                      )}
                      title={crumb.path || projectName}
                    />
                  }
                >
                  {crumb.label}
                </MenuTrigger>
                {openCrumbPath === crumb.path ? (
                  <FileBreadcrumbPickerMenu
                    key={crumb.path}
                    environmentId={environmentId}
                    cwd={cwd}
                    projectName={projectName}
                    initialDirectoryPath={crumb.path}
                    selectedFilePath={relativePath}
                    onOpenFile={onOpenFile}
                    onRequestClose={() => setOpenCrumbPath(null)}
                  />
                ) : null}
              </Menu>
            )}
          </div>
        );
      })}
    </div>
  );
}
