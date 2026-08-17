import type { ProjectEntry } from "@t3tools/contracts";

export interface FileBreadcrumbPickerEntry extends ProjectEntry {
  readonly label: string;
}

export type FileBreadcrumbEntryIndex = ReadonlyMap<string, readonly FileBreadcrumbPickerEntry[]>;

export type FileBreadcrumbPickerListing =
  | { readonly state: "loading" }
  | { readonly state: "error"; readonly message: string }
  | {
      readonly state: "ready";
      readonly entries: readonly FileBreadcrumbPickerEntry[];
      readonly message: string | null;
      readonly incomplete: boolean;
    };

const entryCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function normalizeRelativePath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function entryParentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "" : path.slice(0, separatorIndex);
}

function entryLabel(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? path : path.slice(separatorIndex + 1);
}

function compareEntries(left: FileBreadcrumbPickerEntry, right: FileBreadcrumbPickerEntry): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return entryCollator.compare(left.label, right.label) || left.path.localeCompare(right.path);
}

export function buildFileBreadcrumbEntryIndex(
  entries: ReadonlyArray<ProjectEntry>,
): FileBreadcrumbEntryIndex {
  const entriesByParent = new Map<string, Map<string, FileBreadcrumbPickerEntry>>();
  for (const entry of entries) {
    const path = normalizeRelativePath(entry.path);
    if (!path) continue;
    const parentPath = entryParentPath(path);
    let children = entriesByParent.get(parentPath);
    if (!children) {
      children = new Map();
      entriesByParent.set(parentPath, children);
    }
    children.set(path, { path, kind: entry.kind, label: entryLabel(path) });
  }

  return new Map(
    [...entriesByParent].map(([parentPath, children]) => [
      parentPath,
      [...children.values()].sort(compareEntries),
    ]),
  );
}

export function fileBreadcrumbDirectoryParent(path: string): string | null {
  const normalizedPath = normalizeRelativePath(path);
  if (!normalizedPath) return null;
  return entryParentPath(normalizedPath);
}

export function fileBreadcrumbDirectoryLabel(path: string, projectName: string): string {
  const normalizedPath = normalizeRelativePath(path);
  return normalizedPath ? entryLabel(normalizedPath) : projectName;
}

export function fileBreadcrumbBackTarget(
  initialDirectoryPath: string,
  currentDirectoryPath: string,
): string | null {
  const initialPath = normalizeRelativePath(initialDirectoryPath);
  const currentPath = normalizeRelativePath(currentDirectoryPath);
  if (currentPath === initialPath) return null;
  const parentPath = fileBreadcrumbDirectoryParent(currentPath);
  if (parentPath === null) return null;
  if (!initialPath || parentPath === initialPath || parentPath.startsWith(`${initialPath}/`)) {
    return parentPath;
  }
  return null;
}

export function resolveFileBreadcrumbPickerListing(input: {
  readonly index: FileBreadcrumbEntryIndex | null;
  readonly directoryPath: string;
  readonly error: string | null;
  readonly truncated: boolean;
}): FileBreadcrumbPickerListing {
  if (input.index === null) {
    return input.error ? { state: "error", message: input.error } : { state: "loading" };
  }

  const directoryPath = normalizeRelativePath(input.directoryPath);
  const entries = input.index.get(directoryPath) ?? [];
  if (input.truncated) {
    return {
      state: "ready",
      entries,
      incomplete: true,
      message:
        entries.length === 0
          ? "No listed entries—workspace listing is incomplete."
          : "Workspace listing may be incomplete.",
    };
  }
  return {
    state: "ready",
    entries,
    incomplete: false,
    message: entries.length === 0 ? "This folder is empty." : null,
  };
}
