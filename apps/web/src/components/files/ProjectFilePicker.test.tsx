import { EnvironmentId, type ScopedThreadRef } from "@t3tools/contracts";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import type { CommandPaletteActionItem } from "../CommandPalette.logic";

vi.mock("react", async (original) => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...(await original<typeof import("react")>()),
    useState: reactHookHarness.useState,
    useMemo: reactHookHarness.useMemo,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const mocks = vi.hoisted(() => ({ openFile: vi.fn() }));
vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: mocks.openFile }) },
}));
vi.mock("~/hooks/useActiveProjectTarget", () => ({ useActiveProjectTarget: () => null }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("~/state/server", () => ({ primaryServerKeybindingsAtom: Symbol("bindings") }));
vi.mock("./projectFilesQueryState", () => ({
  useProjectFilePickerQuery: () => ({
    entries: [{ kind: "file", path: "run.py" }],
    matchedQuery: "",
    error: null,
    isPending: false,
  }),
}));

import { ProjectFilePickerForTarget } from "./ProjectFilePicker";
const target = {
  environmentId: EnvironmentId.make("env"),
  cwd: "/synthetic",
  projectName: "Synthetic",
  threadRef: {} as ScopedThreadRef,
};

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
});

it.each([false, true])(
  "preserves ordinary opening and permits an explicit scoped action: %s",
  async (custom) => {
    const onSelectFile = vi.fn();
    const setOpen = vi.fn();
    hooks.beginRender();
    const tree = ProjectFilePickerForTarget({
      target,
      setOpen,
      ...(custom ? { onSelectFile, actionLabel: "Run saved file" } : {}),
    }) as ReactElement<Record<string, unknown>>;
    const results = visitElements(tree, (element) => Array.isArray(element.props.groups));
    const groups = results?.props.groups as { items: CommandPaletteActionItem[] }[];
    const action = groups[0]!.items[0]!;
    await action.run();
    if (custom) {
      expect(onSelectFile).toHaveBeenCalledWith("run.py");
      expect(mocks.openFile).not.toHaveBeenCalled();
    } else {
      expect(mocks.openFile).toHaveBeenCalledWith(target.threadRef, "run.py");
      expect(onSelectFile).not.toHaveBeenCalled();
    }
  },
);
