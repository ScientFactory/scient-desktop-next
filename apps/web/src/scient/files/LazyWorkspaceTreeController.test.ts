import { FileTree } from "@pierre/trees";
import type {
  ProjectDirectoryEntry,
  ProjectDirectoryView,
  ProjectListDirectoryResult,
} from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  refreshProjectFiles,
  subscribeProjectFilesRefresh,
} from "~/components/files/projectFilesQueryState";

import {
  LazyWorkspaceTreeController,
  type LazyWorkspaceTreeSnapshot,
} from "./LazyWorkspaceTreeController.ts";

function directory(relativePath: string, readOnly = false): ProjectDirectoryEntry {
  return {
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "directory",
    readOnly,
  };
}

function file(relativePath: string, readOnly = false): ProjectDirectoryEntry {
  return {
    name: relativePath.split("/").at(-1)!,
    relativePath,
    kind: "file",
    readOnly,
  };
}

function complete(...entries: ProjectDirectoryEntry[]): ProjectListDirectoryResult {
  return { entries, complete: true };
}

function makeController(
  loadDirectory: (
    relativeDirectory: string,
    view: ProjectDirectoryView,
  ) => Promise<ProjectListDirectoryResult>,
) {
  const model = new FileTree({
    paths: [],
    fileTreeSearchMode: "hide-non-matches",
    flattenEmptyDirectories: false,
    initialExpansion: "closed",
  });
  let snapshot: LazyWorkspaceTreeSnapshot | null = null;
  const controller = new LazyWorkspaceTreeController({
    model,
    loadDirectory,
    onSnapshot: (next) => {
      snapshot = next;
    },
  });
  return {
    controller,
    model,
    snapshot: () => snapshot,
    destroy: () => {
      controller.destroy();
      model.cleanUp();
    },
  };
}

describe("LazyWorkspaceTreeController", () => {
  it("reveals generated files when a known workspace write requests refresh", async () => {
    const environmentId = EnvironmentId.make("compute-workspace-refresh-test");
    let generated = false;
    const harness = makeController(async () =>
      generated ? complete(file("analysis.py"), file("result.csv")) : complete(file("analysis.py")),
    );
    let refreshed: Promise<void> | null = null;
    await harness.controller.start();
    const unsubscribe = subscribeProjectFilesRefresh(environmentId, "/compute-refresh-test", () => {
      refreshed = harness.controller.refresh();
    });
    try {
      expect(harness.model.getItem("result.csv")).toBeNull();
      generated = true;
      refreshProjectFiles(environmentId, "/compute-refresh-test");
      expect(refreshed).not.toBeNull();
      await refreshed;
      expect(harness.model.getItem("result.csv")).not.toBeNull();
    } finally {
      unsubscribe();
      harness.destroy();
    }
  });

  it("loads only the root and branches the user expands", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> =>
        relativeDirectory === ""
          ? complete(directory("src"), file("README.md"))
          : complete(file("src/index.ts")),
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    expect(loadDirectory).toHaveBeenCalledTimes(1);
    expect(harness.model.getItem("src")?.isDirectory()).toBe(true);
    expect(harness.model.getItem("src/index.ts")).toBeNull();

    const src = harness.model.getItem("src");
    if (!src || !("expand" in src)) throw new Error("Expected src directory");
    src.expand();
    await harness.controller.load("src");

    expect(loadDirectory).toHaveBeenNthCalledWith(2, "src", "ordinary");
    expect(harness.model.getItem("src/index.ts")).not.toBeNull();
    harness.destroy();
  });

  it("refreshes loaded branches incrementally without resetting expansion", async () => {
    let revision = 0;
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return revision === 0
            ? complete(directory("src"), file("README.md"))
            : complete(directory("src"), file(".env"));
        }
        return revision === 0 ? complete(file("src/old.ts")) : complete(file("src/current.ts"));
      },
    );
    const harness = makeController(loadDirectory);
    const resetSpy = vi.spyOn(harness.model, "resetPaths");

    await harness.controller.start();
    const src = harness.model.getItem("src");
    if (!src || !("expand" in src)) throw new Error("Expected src directory");
    src.expand();
    await harness.controller.load("src");

    revision = 1;
    await harness.controller.refresh();

    expect(resetSpy).not.toHaveBeenCalled();
    expect("isExpanded" in src && src.isExpanded()).toBe(true);
    expect(harness.model.getItem("README.md")).toBeNull();
    expect(harness.model.getItem(".env")).not.toBeNull();
    expect(harness.model.getItem("src/old.ts")).toBeNull();
    expect(harness.model.getItem("src/current.ts")).not.toBeNull();
    harness.destroy();
  });

  it("loads ancestors on demand for files opened outside the tree", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"));
          case "src":
            return complete(directory("src/components"));
          default:
            return complete(file("src/components/Composer.tsx"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    expect(await harness.controller.ensurePath("src/components/Composer.tsx")).toBe(true);
    expect(loadDirectory.mock.calls.map(([relativeDirectory]) => relativeDirectory)).toEqual([
      "",
      "src",
      "src/components",
    ]);
    expect(harness.model.getItem("src/components/Composer.tsx")).not.toBeNull();
    harness.destroy();
  });

  it("primes indexed paths without changing normal expansion", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"), directory("docs"));
          case "src":
            return complete(directory("src/components"));
          case "src/components":
            return complete(file("src/components/Composer.tsx"));
          default:
            return complete(file("docs/guide.md"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    await harness.controller.primePaths([
      "src/components/Composer.tsx",
      "docs/guide.md",
      "src/components",
    ]);

    expect(loadDirectory.mock.calls.map(([relativeDirectory]) => relativeDirectory)).toEqual([
      "",
      "src",
      "docs",
      "src/components",
    ]);
    expect(harness.model.getItem("src/components/Composer.tsx")).not.toBeNull();
    expect(harness.model.getItem("docs/guide.md")).not.toBeNull();
    for (const path of ["src", "src/components", "docs"]) {
      const item = harness.model.getItem(path);
      if (!item || !("isExpanded" in item)) throw new Error(`Expected ${path} directory`);
      expect(item.isExpanded()).toBe(false);
    }
    harness.model.setSearch("components");
    expect(harness.model.getSearchMatchingPaths()).toEqual([
      "src/components/",
      "src/components/Composer.tsx",
    ]);
    harness.model.closeSearch();
    harness.destroy();
  });

  it("filters primed paths in the same model and restores expansion and selection", async () => {
    const loadDirectory = vi.fn(
      async (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        switch (relativeDirectory) {
          case "":
            return complete(directory("src"), directory("docs"), file("README.md"));
          case "src":
            return complete(directory("src/components"));
          case "src/components":
            return complete(file("src/components/Composer.tsx"));
          default:
            return complete(file("docs/notes.md"));
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const src = harness.model.getItem("src");
    const docs = harness.model.getItem("docs");
    if (!src || !("isExpanded" in src)) throw new Error("Expected src directory");
    if (!docs || !("isExpanded" in docs)) throw new Error("Expected docs directory");
    docs.expand();
    await harness.controller.load("docs");
    harness.model.getItem("docs/notes.md")?.select();

    harness.model.setSearch("Composer");
    await harness.controller.primePaths(["src/components/Composer.tsx"]);

    expect(harness.model.getSearchMatchingPaths()).toEqual(["src/components/Composer.tsx"]);
    expect(src.isExpanded()).toBe(true);
    expect(docs.isExpanded()).toBe(false);

    harness.model.closeSearch();

    expect(src.isExpanded()).toBe(false);
    expect(docs.isExpanded()).toBe(true);
    expect(harness.model.getSelectedPaths()).toEqual(["docs/notes.md"]);
    harness.destroy();
  });

  it("ignores stale responses after the internal view changes", async () => {
    const pending = new Map<ProjectDirectoryView, (result: ProjectListDirectoryResult) => void>();
    const loadDirectory = vi.fn(
      (_relativeDirectory: string, view: ProjectDirectoryView) =>
        new Promise<ProjectListDirectoryResult>((resolve) => pending.set(view, resolve)),
    );
    const harness = makeController(loadDirectory);

    const ordinary = harness.controller.start();
    const withInternals = harness.controller.setView("with-internals");
    pending.get("with-internals")!(complete(directory(".git", true)));
    await withInternals;
    pending.get("ordinary")!(complete(file("ordinary.txt")));
    await ordinary;

    expect(harness.model.getItem(".git")).not.toBeNull();
    expect(harness.model.getItem("ordinary.txt")).toBeNull();
    harness.destroy();
  });

  it("keeps durable sources visible while switching workspace internals", async () => {
    const loadDirectory = vi.fn(
      async (
        relativeDirectory: string,
        view: ProjectDirectoryView,
      ): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === ".scient") {
          return complete(directory(".scient/skills"), directory(".scient/sources", true));
        }
        switch (view) {
          case "ordinary":
            return complete(file("project.txt"), directory(".scient", true));
          case "with-internals":
            return complete(
              file("project.txt"),
              directory(".scient", true),
              directory(".git", true),
            );
        }
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    expect(harness.model.getItem("project.txt")).not.toBeNull();
    expect(harness.model.getItem(".scient")).not.toBeNull();
    await harness.controller.load(".scient");
    expect(harness.model.getItem(".scient/skills")).not.toBeNull();
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();

    await harness.controller.setView("with-internals");
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();
    expect(harness.model.getItem(".git")).not.toBeNull();

    await harness.controller.setView("ordinary");
    expect(harness.model.getItem(".scient/skills")).not.toBeNull();
    expect(harness.model.getItem(".scient/sources")).not.toBeNull();
    expect(harness.model.getItem(".git")).toBeNull();
    expect(loadDirectory.mock.calls.map(([, view]) => view)).toEqual([
      "ordinary",
      "ordinary",
      "with-internals",
      "with-internals",
      "ordinary",
      "ordinary",
    ]);
    harness.destroy();
  });

  it("keeps refresh state owned by the latest view request", async () => {
    const pending: Array<{
      view: ProjectDirectoryView;
      resolve: (result: ProjectListDirectoryResult) => void;
    }> = [];
    const loadDirectory = vi.fn(
      (_relativeDirectory: string, view: ProjectDirectoryView) =>
        new Promise<ProjectListDirectoryResult>((resolve) => pending.push({ view, resolve })),
    );
    const harness = makeController(loadDirectory);

    const ordinaryStart = harness.controller.start();
    const internalsRefresh = harness.controller.setView("with-internals");
    const ordinaryRefresh = harness.controller.setView("ordinary");

    pending.find(({ view }) => view === "with-internals")!.resolve(complete(directory(".git")));
    await internalsRefresh;
    expect(harness.snapshot()?.isPending).toBe(true);

    pending.at(-1)!.resolve(complete(file("README.md")));
    await ordinaryRefresh;
    pending[0]!.resolve(complete(file("stale.txt")));
    await ordinaryStart;

    expect(harness.snapshot()?.isPending).toBe(false);
    expect(harness.model.getItem("README.md")).not.toBeNull();
    expect(harness.model.getItem(".git")).toBeNull();
    expect(harness.model.getItem("stale.txt")).toBeNull();
    harness.destroy();
  });

  it("does not restore a branch removed while its request is pending", async () => {
    let rootRevision = 0;
    let resolveBranch!: (result: ProjectListDirectoryResult) => void;
    const loadDirectory = vi.fn(
      (relativeDirectory: string): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return Promise.resolve(
            rootRevision === 0 ? complete(directory("src")) : complete(file("README.md")),
          );
        }
        return new Promise<ProjectListDirectoryResult>((resolve) => {
          resolveBranch = resolve;
        });
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const staleBranch = harness.controller.load("src");
    rootRevision = 1;
    await harness.controller.refresh();
    resolveBranch(complete(file("src/stale.ts")));
    await staleBranch;

    expect(harness.model.getItem("src")).toBeNull();
    expect(harness.model.getItem("src/stale.ts")).toBeNull();
    expect(harness.model.getItem("README.md")).not.toBeNull();
    harness.destroy();
  });

  it("does not leave stale branch requests pending after a view refresh fails", async () => {
    let resolveOrdinaryBranch!: (result: ProjectListDirectoryResult) => void;
    const loadDirectory = vi.fn(
      (
        relativeDirectory: string,
        view: ProjectDirectoryView,
      ): Promise<ProjectListDirectoryResult> => {
        if (relativeDirectory === "") {
          return view === "ordinary"
            ? Promise.resolve(complete(directory("src")))
            : Promise.reject(new Error("Could not load internals."));
        }
        if (view === "ordinary") {
          return new Promise<ProjectListDirectoryResult>((resolve) => {
            resolveOrdinaryBranch = resolve;
          });
        }
        return Promise.resolve(complete(file("src/current.ts")));
      },
    );
    const harness = makeController(loadDirectory);

    await harness.controller.start();
    const staleBranch = harness.controller.load("src");
    await harness.controller.setView("with-internals");

    expect(harness.snapshot()?.isPending).toBe(false);
    expect(harness.snapshot()?.rootError).toBe("Could not load internals.");
    resolveOrdinaryBranch(complete(file("src/stale.ts")));
    await staleBranch;
    expect(harness.snapshot()?.isPending).toBe(false);

    expect(await harness.controller.retry("src")).toBe(true);
    expect(harness.model.getItem("src/stale.ts")).toBeNull();
    expect(harness.model.getItem("src/current.ts")).not.toBeNull();
    harness.destroy();
  });

  it("reports incomplete branches without presenting partial rows", async () => {
    const harness = makeController(async () => ({
      entries: [file("partial.txt")],
      complete: false,
    }));

    expect(await harness.controller.start()).toBe(false);
    expect(harness.model.getItem("partial.txt")).toBeNull();
    expect(harness.snapshot()?.rootError).toContain("incomplete directory listing");
    harness.destroy();
  });
});
