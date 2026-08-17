import type { ProjectEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFileBreadcrumbEntryIndex,
  fileBreadcrumbBackTarget,
  fileBreadcrumbDirectoryLabel,
  fileBreadcrumbDirectoryParent,
  resolveFileBreadcrumbPickerListing,
} from "./fileBreadcrumbPicker";

const entries = [
  { path: "src-old/legacy.ts", kind: "file" },
  { path: "src/components", kind: "directory" },
  { path: "src/index.ts", kind: "file" },
  { path: "src/components/Button10.tsx", kind: "file" },
  { path: "src/components/Button2.tsx", kind: "file" },
  { path: "README.md", kind: "file" },
  { path: "src", kind: "directory" },
  { path: "src-old", kind: "directory" },
] satisfies ProjectEntry[];

describe("file breadcrumb entry index", () => {
  it("groups only direct children and keeps similar prefixes separate", () => {
    const index = buildFileBreadcrumbEntryIndex(entries);

    expect(index.get("")?.map((entry) => entry.path)).toEqual(["src", "src-old", "README.md"]);
    expect(index.get("src")?.map((entry) => entry.path)).toEqual([
      "src/components",
      "src/index.ts",
    ]);
    expect(index.get("src-old")?.map((entry) => entry.path)).toEqual(["src-old/legacy.ts"]);
  });

  it("sorts directories first and file names naturally", () => {
    const index = buildFileBreadcrumbEntryIndex(entries);

    expect(index.get("src/components")?.map((entry) => entry.label)).toEqual([
      "Button2.tsx",
      "Button10.tsx",
    ]);
  });

  it("normalizes repeated separators and deduplicates paths", () => {
    const index = buildFileBreadcrumbEntryIndex([
      { path: "/src//index.ts", kind: "file" },
      { path: "src/index.ts", kind: "file" },
    ]);

    expect(index.get("src")).toEqual([{ path: "src/index.ts", kind: "file", label: "index.ts" }]);
  });

  it("resolves directory parents and display labels", () => {
    expect(fileBreadcrumbDirectoryParent("")).toBeNull();
    expect(fileBreadcrumbDirectoryParent("src")).toBe("");
    expect(fileBreadcrumbDirectoryParent("src/components")).toBe("src");
    expect(fileBreadcrumbDirectoryLabel("", "Scient")).toBe("Scient");
    expect(fileBreadcrumbDirectoryLabel("src/components", "Scient")).toBe("components");
  });

  it("keeps Back navigation within the crumb that opened the picker", () => {
    expect(fileBreadcrumbBackTarget("src", "src")).toBeNull();
    expect(fileBreadcrumbBackTarget("src", "src/components/forms")).toBe("src/components");
    expect(fileBreadcrumbBackTarget("src", "src/components")).toBe("src");
    expect(fileBreadcrumbBackTarget("", "src")).toBe("");
    expect(fileBreadcrumbBackTarget("src", "other/components")).toBeNull();
  });
});

describe("file breadcrumb picker listing", () => {
  it("distinguishes loading and query errors before data arrives", () => {
    expect(
      resolveFileBreadcrumbPickerListing({
        index: null,
        directoryPath: "src",
        error: null,
        truncated: false,
      }),
    ).toEqual({ state: "loading" });
    expect(
      resolveFileBreadcrumbPickerListing({
        index: null,
        directoryPath: "src",
        error: "Workspace query failed.",
        truncated: false,
      }),
    ).toEqual({ state: "error", message: "Workspace query failed." });
  });

  it("does not describe a truncated directory as empty", () => {
    expect(
      resolveFileBreadcrumbPickerListing({
        index: new Map(),
        directoryPath: "src",
        error: null,
        truncated: true,
      }),
    ).toEqual({
      state: "ready",
      entries: [],
      incomplete: true,
      message: "No listed entries—workspace listing is incomplete.",
    });
  });

  it("marks populated truncated listings and truly empty complete listings accurately", () => {
    const index = buildFileBreadcrumbEntryIndex(entries);
    expect(
      resolveFileBreadcrumbPickerListing({
        index,
        directoryPath: "src",
        error: null,
        truncated: true,
      }),
    ).toMatchObject({
      state: "ready",
      incomplete: true,
      message: "Workspace listing may be incomplete.",
    });
    expect(
      resolveFileBreadcrumbPickerListing({
        index,
        directoryPath: "missing",
        error: null,
        truncated: false,
      }),
    ).toEqual({
      state: "ready",
      entries: [],
      incomplete: false,
      message: "This folder is empty.",
    });
  });
});
