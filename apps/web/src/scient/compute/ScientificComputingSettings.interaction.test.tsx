// @vitest-environment happy-dom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  EnvironmentId,
  type ComputeLanguageRuntimeInventory,
  type ComputeManagedRuntimeStatus,
  type ScientificComputingLanguageSettings,
} from "@t3tools/contracts";

const mocks = vi.hoisted(() => ({
  preferences: {} as Record<string, ScientificComputingLanguageSettings>,
  languages: [] as ComputeLanguageRuntimeInventory[],
  statuses: {} as Record<string, ComputeManagedRuntimeStatus | null>,
  revision: 0,
  listeners: new Set<() => void>(),
  saveFails: false,
  releaseFails: false,
  calls: [] as string[],
  update: vi.fn(),
  manage: vi.fn(),
  verify: vi.fn(),
}));
function notify() {
  mocks.revision++;
  for (const listener of mocks.listeners) listener();
}
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (result: { cause: Error }) => result.cause,
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local",
  useEnvironment: (id: string) => ({ environmentId: id, label: id }),
}));
vi.mock("~/components/settings/settingsLayout", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/settings/settingsLayout")>()),
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("~/hooks/useSettings", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    usePrimarySettingsAvailable: () => true,
    useEnvironmentSettings: () => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => mocks.revision,
      );
      return { schemaVersion: 1, languages: mocks.preferences };
    },
  };
});
vi.mock("~/state/server", () => ({ serverEnvironment: { updateSettings: "update" } }));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    runtimeInventory: () => ({ kind: "inventory" }),
    managedRuntime: ({ input }: { input: { languageId: string } }) => ({
      kind: "managed",
      languageId: input.languageId,
    }),
    manageRuntime: "manage",
    verifyRuntime: "verify",
    refreshRuntimeInventory: "refresh",
    cancelManagedRuntime: "cancel",
  },
}));
vi.mock("~/state/query", async () => {
  const { useSyncExternalStore } = await import("react");
  return {
    useEnvironmentQuery: (atom: { kind: string; languageId?: string } | null) => {
      useSyncExternalStore(
        (listener) => {
          mocks.listeners.add(listener);
          return () => {
            mocks.listeners.delete(listener);
          };
        },
        () => mocks.revision,
      );
      return {
        data:
          atom?.kind === "inventory"
            ? { languages: mocks.languages }
            : atom?.languageId
              ? mocks.statuses[atom.languageId]
              : undefined,
        isPending: false,
        error: null,
        refresh: vi.fn(),
      };
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (atom: string) =>
    atom === "update"
      ? mocks.update
      : atom === "manage"
        ? mocks.manage
        : atom === "verify"
          ? mocks.verify
          : vi.fn(async () => ({ _tag: "Success", value: null })),
}));
import { ScientificComputingSettings } from "./ScientificComputingSettings";

const managedPath = "/scient/python";
const systemPath = "/system/python";
const status = (): ComputeManagedRuntimeStatus => ({
  installed: true,
  selection: "managed",
  updateAvailable: false,
  runtimeVersion: "3.12.13",
  toolkitRevision: null,
  generationId: "g1",
  operation: null,
  failureMessage: null,
});
function python(): ComputeLanguageRuntimeInventory {
  return {
    descriptor: {
      languageId: ComputeLanguageId.make("python"),
      displayName: "Python",
      sourceExtensions: [".py"],
      capabilities: [],
    },
    enabled: true,
    configuredExecutable: null,
    managedRuntime: status(),
    toolkits: [],
    failureMessage: null,
    installations: [
      { executable: managedPath, source: "managed", version: "3.12.13", problem: null },
      { executable: systemPath, source: "path", version: null, problem: null },
    ],
  };
}

describe("Scientific Computing settings interactions", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.preferences = { python: { enabled: true, executable: "" } };
    mocks.languages = [python()];
    mocks.statuses = { python: status() };
    mocks.saveFails = false;
    mocks.releaseFails = false;
    mocks.calls = [];
    mocks.update.mockReset().mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push("save");
      if (mocks.saveFails) return { _tag: "Failure", cause: new Error("Save rejected") };
      mocks.preferences = { ...mocks.preferences, ...input.patch.scientificComputing.languages };
      notify();
      return { _tag: "Success", value: null };
    });
    mocks.manage.mockReset().mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push(input.action);
      if (mocks.releaseFails) return { _tag: "Failure", cause: new Error("Busy operation") };
      const current = mocks.statuses[input.languageId];
      if (current && ["use-managed", "use-existing"].includes(input.action))
        mocks.statuses = {
          ...mocks.statuses,
          [input.languageId]: {
            ...current,
            selection: input.action === "use-managed" ? "managed" : "existing",
          },
        };
      notify();
      return { _tag: "Success", value: mocks.statuses[input.languageId] };
    });
    mocks.verify.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(() =>
      root.render(<ScientificComputingSettings environmentId={EnvironmentId.make("remote")} />),
    );
  };
  const runtimeSelect = (languageName = "Python") => {
    const match = container.querySelector<HTMLElement>(
      `[data-slot="select-trigger"][aria-label="Choose ${languageName} runtime"]`,
    );
    expect(match, `Choose ${languageName} runtime`).toBeDefined();
    return match!;
  };
  const runtimeValue = (languageName = "Python") =>
    runtimeSelect(languageName).getAttribute("data-compute-runtime");
  const chooseRuntime = async (path: string, languageName = "Python") => {
    const picker = runtimeSelect(languageName);
    await act(() => picker.click());
    const item = [...document.querySelectorAll<HTMLElement>('[data-slot="select-item"]')].find(
      (node) => node.getAttribute("data-compute-runtime") === path,
    );
    expect(item, `runtime option ${path}`).toBeDefined();
    await act(() => item!.click());
  };
  const button = (label: string, scope: ParentNode = container) => {
    const match = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent?.trim() === label,
    );
    expect(match, label).toBeDefined();
    return match!;
  };
  const click = async (label: string, scope?: ParentNode) => {
    await act(() => button(label, scope).click());
  };

  it("shows the current runtime without an installation dashboard", async () => {
    await render();
    expect(container.querySelector("[data-compute-installation]")).toBeNull();
    expect(container.querySelector("[data-compute-summary] button")).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (node) => node.textContent?.trim() === "Details",
      ),
    ).toBe(false);
    expect(container.textContent).not.toContain("More scientific tools are coming soon");
    expect(container.textContent).toContain("Change runtime");
    expect(container.textContent).toContain("3.12.13");
    expect(container.textContent).toContain("Scient-managed");
    expect(container.querySelectorAll("h3")).toHaveLength(1);
    expect(runtimeValue()).toBe(managedPath);
    expect(button("Test").title).toBe("Starts and closes a test session.");
    expect(container.textContent).not.toContain(managedPath);
    expect(container.querySelector("select")).toBeNull();
    const actions = container.querySelector("[data-compute-actions='python']");
    expect(actions?.textContent).toContain("Test");
    expect(actions?.textContent).toContain("Repair");
    expect(actions?.textContent).toContain("Remove");
  });

  it("keeps the grouped Settings card used by other Settings pages", async () => {
    const matlabPath = "/MATLAB/bin/matlab";
    mocks.preferences = {
      python: { enabled: true, executable: "" },
      matlab: { enabled: true, executable: matlabPath },
    };
    mocks.statuses = { python: status(), matlab: null };
    mocks.languages = [
      python(),
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
          sourceExtensions: [".m"],
        },
        managedRuntime: null,
        configuredExecutable: matlabPath,
        installations: [
          { executable: matlabPath, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    expect(container.querySelector("h2")?.textContent).toContain("Scientific Computing");
    expect(container.textContent).not.toContain("Python & MATLAB");
    expect(container.textContent).not.toContain("Advanced");
    const rows = container.querySelectorAll("[data-slot=settings-row]");
    expect(rows).toHaveLength(2);
    const card = container.querySelector("div.rounded-xl.border");
    expect(card).not.toBeNull();
    expect(card?.className).toContain("bg-card/40");
    expect(card?.querySelectorAll("[data-slot=settings-row]")).toHaveLength(2);
    expect(container.querySelector("[data-compute-installation]")).toBeNull();
    expect(container.querySelector("[data-compute-summary='python']")?.textContent).toContain(
      "3.12.13",
    );
    expect(container.querySelector("[data-compute-summary='matlab']")?.textContent).toContain(
      "R2026a",
    );
  });

  it("treats Test passed as a started-and-closed session, not a metadata probe", async () => {
    mocks.verify.mockImplementation(async ({ environmentId, input }) => {
      expect(environmentId).toBe("remote");
      mocks.calls.push("verify");
      return {
        _tag: "Success",
        value: {
          profile: {
            languageId: input.languageId,
            source: "managed",
            executable: input.executable,
            languageVersion: "3.12.13",
            architecture: null,
            displayName: "Python",
          },
          readiness: "ready",
          connection: "verified",
          missingRequirements: [],
          packages: [],
          message: "Connection verified. The test session was closed.",
        },
      };
    });
    await render();
    await click("Test");
    expect(mocks.calls).toEqual(["verify"]);
    expect(button("Test passed")).toBeDefined();
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("does not treat a Python probe as Test passed or send people to Repair", async () => {
    mocks.verify.mockImplementation(async () => ({
      _tag: "Success",
      value: {
        profile: {
          languageId: "python",
          source: "managed",
          executable: managedPath,
          languageVersion: "3.12.13",
          architecture: null,
          displayName: "Python",
        },
        readiness: "ready",
        missingRequirements: [],
        packages: [],
        message: null,
      },
    }));
    await render();
    await click("Test");
    expect(container.textContent).not.toContain("Test passed");
    expect(container.textContent).toContain("did not start a test session");
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("keeps a helper provision failure in Change runtime, not the default MATLAB story", async () => {
    const matlab = "/MATLAB/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: matlab,
      failureMessage: "ENOENT: uv.lock",
    };
    mocks.preferences = { matlab: { enabled: true, executable: matlab } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: matlab,
        installations: [
          { executable: matlab, source: "conventional", version: "R2026a", problem: null },
        ],
      },
    ];
    await render();
    const summary = container.querySelector("[data-compute-summary='matlab']");
    const recovery = container.querySelector("[data-compute-recovery='matlab']");
    expect(summary?.textContent).toContain("R2026a");
    expect(summary?.textContent).toContain("System installation");
    expect(summary?.textContent).not.toContain("ENOENT");
    expect(recovery?.textContent).toContain("ENOENT");
    expect(recovery?.querySelector("[data-compute-notice]")).not.toBeNull();
  });

  it("selects system Python by saving first and releasing managed precedence exactly once", async () => {
    await render();
    await chooseRuntime(systemPath);
    await chooseRuntime(systemPath);
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe(systemPath);
    expect(runtimeValue()).toBe(systemPath);
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("does not switch or release managed Python when saving fails", async () => {
    mocks.saveFails = true;
    await render();
    await chooseRuntime(systemPath);
    expect(mocks.calls).toEqual(["save"]);
    expect(runtimeValue()).toBe(managedPath);
    expect(container.textContent).toContain("Settings were not saved");
  });

  it("keeps the real managed default when release fails and allows retry", async () => {
    mocks.releaseFails = true;
    await render();
    await chooseRuntime(systemPath);
    expect(runtimeValue()).toBe(managedPath);
    expect(container.textContent).toContain("still selected");
    mocks.releaseFails = false;
    await chooseRuntime(systemPath);
    expect(runtimeValue()).toBe(systemPath);
    expect(container.textContent).not.toContain("still selected");
  });

  it("resets automatic discovery without leaving managed precedence active", async () => {
    mocks.preferences.python = { enabled: true, executable: "/old/python" };
    await render();
    await click("Reset to automatic");
    expect(mocks.calls).toEqual(["save", "use-existing"]);
    expect(mocks.preferences.python?.executable).toBe("");
    expect(runtimeValue()).toBe(systemPath);
  });

  it("does not save a custom path on blur or Cancel; saves only on explicit submission", async () => {
    await render();
    await click("Use another path…");
    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="Python executable path"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "/custom/python",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
    });
    expect(mocks.update).not.toHaveBeenCalled();
    await click("Cancel");
    expect(mocks.update).not.toHaveBeenCalled();
    await click("Use another path…");
    const next = container.querySelector<HTMLInputElement>(
      'input[aria-label="Python executable path"]',
    )!;
    await act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        next,
        "/custom/python",
      );
      next.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      container
        .querySelector("form")!
        .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
    );
    expect(mocks.preferences.python?.executable).toBe("/custom/python");
    expect(mocks.calls).toEqual(["save", "use-existing"]);
  });

  it("keeps disabled managed Python removable without falsely saying it needs repair", async () => {
    mocks.preferences.python = { enabled: false, executable: "" };
    mocks.languages = [{ ...python(), enabled: false, installations: [] }];
    await render();
    expect(container.textContent).not.toContain("needs repair");
    expect(button("Remove").disabled).toBe(false);
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("ties helper maintenance to the selected MATLAB, not an inventory of rows", async () => {
    const a = "/MATLAB-A/bin/matlab";
    const b = "/MATLAB-B/bin/matlab";
    const helper = {
      ...status(),
      displayName: "MATLAB connection helper",
      installationExecutable: a,
    };
    mocks.preferences = { matlab: { enabled: true, executable: b } };
    mocks.statuses = { matlab: helper };
    mocks.languages = [
      {
        ...python(),
        descriptor: {
          ...python().descriptor,
          languageId: ComputeLanguageId.make("matlab"),
          displayName: "MATLAB",
        },
        managedRuntime: helper,
        configuredExecutable: b,
        installations: [
          { executable: a, source: "conventional", version: "R2025b", problem: null },
          {
            executable: b,
            source: "conventional",
            version: "R2026a",
            problem: null,
            configured: true,
          },
        ],
      },
    ];
    await render();
    expect(container.textContent).toContain("Remove helper");
    expect(container.textContent).toContain("Set up connection");
    expect(button("Repair connection").disabled).toBe(true);
    await chooseRuntime(a, "MATLAB");
    expect(mocks.calls).toEqual(["save"]);
    expect(button("Repair connection").disabled).toBe(false);
    expect(container.textContent).not.toContain("Set up connection");
  });

  it("requires confirmation before removal and keeps cancellation non-mutating", async () => {
    await render();
    await click("Remove");
    expect(mocks.manage).not.toHaveBeenCalled();
    const dialog = document.querySelector<HTMLElement>('[role="alertdialog"]')!;
    expect(dialog.textContent).toContain(
      "System installations and project environments are untouched",
    );
    await click("Cancel", dialog);
    expect(mocks.manage).not.toHaveBeenCalled();
    await click("Remove");
    await click("Remove", document.querySelector<HTMLElement>('[role="alertdialog"]')!);
    expect(mocks.calls).toEqual(["remove"]);
  });

  it("keeps repair reachable for a missing managed executable", async () => {
    mocks.languages = [
      {
        ...python(),
        installations: [
          {
            executable: managedPath,
            source: "managed",
            version: "3.12.13",
            problem: "Scient-managed Python needs repair.",
          },
        ],
      },
    ];
    await render();
    expect(button("Repair").disabled).toBe(false);
    expect(container.textContent).toContain("needs repair");
    expect(mocks.manage).not.toHaveBeenCalled();
  });

  it("survives repeated changes between managed and existing Python without duplicate mutations", async () => {
    await render();
    for (let n = 0; n < 25; n++) {
      await chooseRuntime(systemPath);
      expect(runtimeValue()).toBe(systemPath);
      await chooseRuntime(managedPath);
      expect(runtimeValue()).toBe(managedPath);
    }
    expect(mocks.calls).toEqual(
      Array.from({ length: 25 }, () => ["save", "use-existing", "use-managed"]).flat(),
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
