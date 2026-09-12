import {
  ComputeSessionId,
  ComputeSessionGeneration,
  EnvironmentId,
  type ComputeSessionRecord,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ReactElement } from "react";
import { visitElements } from "~/test/reactElementTree";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";

vi.mock("react", async (importOriginal) => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...(await importOriginal<typeof import("react")>()),
    useState: reactHookHarness.useState,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const mocks = vi.hoisted(() => ({ read: vi.fn(), submit: vi.fn(), toast: vi.fn() }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => mocks.read }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => mocks.submit }));
vi.mock("~/state/compute", () => ({ computeEnvironment: { submitExecution: Symbol("submit") } }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { readFile: Symbol("read") } }));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: mocks.toast } }));
vi.mock("~/components/files/ProjectFilePicker", () => ({ ProjectFilePickerForTarget: () => null }));

import { ComputeSavedFileAction } from "./ComputeSavedFileAction";
import { ProjectFilePickerForTarget } from "~/components/files/ProjectFilePicker";
import {
  ComputeContextId,
  ensureComputeContext,
  useComputeContextStore,
} from "./computeContextStore";

const contextId = ComputeContextId.make("standalone-test");
const sessionId = ComputeSessionId.make("owned-session");
const generation = ComputeSessionGeneration.make(1);
const environmentId = EnvironmentId.make("env");
const session = {
  sessionId,
  generation,
  status: "ready",
  languageId: "python",
  label: "Python",
} as ComputeSessionRecord;
const props = {
  contextId,
  session,
  environmentId,
  cwd: "/synthetic",
  threadRef: {} as ScopedThreadRef,
  disabled: false,
  onSubmitted: vi.fn(),
};
const saved = {
  relativePath: "run.py",
  contents: "print(42)\n",
  revision: "saved-revision",
  truncated: false,
  byteLength: 10,
};

function pickFile() {
  hooks.beginRender();
  const tree = ComputeSavedFileAction(props) as ReactElement<Record<string, unknown>>;
  const button = visitElements(tree, (element) => typeof element.props.title === "string");
  (button?.props.onClick as () => void)();
  hooks.beginRender();
  const opened = ComputeSavedFileAction(props) as ReactElement<Record<string, unknown>>;
  const picker = visitElements(opened, (element) => element.type === ProjectFilePickerForTarget);
  expect(picker?.props.target).toMatchObject({ environmentId, cwd: "/synthetic" });
  (picker?.props.onSelectFile as (path: string) => void)("run.py");
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  useComputeContextStore.setState({ bindings: {} });
  ensureComputeContext({ contextId, environmentId, cwd: "/synthetic" });
  useComputeContextStore.getState().reserveSession({ contextId, sessionId, generation });
  useComputeContextStore.getState().bindSession({ contextId, sessionId, generation });
});

describe("standalone saved-file action", () => {
  it("submits freshly read bytes to this exact session, not another file tab", async () => {
    mocks.read.mockResolvedValue({ _tag: "Success", value: saved });
    mocks.submit.mockResolvedValue({ _tag: "Success", value: { request: { sessionId } } });
    pickFile();
    await vi.waitFor(() => expect(props.onSubmitted).toHaveBeenCalledOnce());
    expect(mocks.submit).toHaveBeenCalledWith({
      environmentId,
      input: expect.objectContaining({
        cwd: "/synthetic",
        sessionId,
        expectedGeneration: generation,
        code: saved.contents,
        source: expect.objectContaining({ bufferState: "saved", revision: saved.revision }),
      }),
    });
  });
  it("does not submit when Stop takes ownership during the file read", async () => {
    let resolveRead!: (value: unknown) => void;
    const pendingRead = new Promise<unknown>((resolve) => {
      resolveRead = resolve;
    });
    mocks.read.mockReturnValue(pendingRead);
    pickFile();
    useComputeContextStore.getState().markClosing(contextId);
    resolveRead({ _tag: "Success", value: saved });
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledOnce());
    expect(mocks.submit).not.toHaveBeenCalled();
  });
  it("reports a read failure without running or replacing the session", async () => {
    mocks.read.mockRejectedValue(new Error("File removed"));
    pickFile();
    await vi.waitFor(() =>
      expect(mocks.toast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "File removed" }),
      ),
    );
    expect(mocks.submit).not.toHaveBeenCalled();
    expect(useComputeContextStore.getState().bindings[contextId]?.sessionId).toBe(sessionId);
  });
});
