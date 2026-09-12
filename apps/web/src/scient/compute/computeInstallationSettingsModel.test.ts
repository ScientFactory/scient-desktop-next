import { describe, expect, it, vi } from "vite-plus/test";
import {
  ComputeLanguageId,
  type ComputeLanguageRuntimeInventory,
  type ComputeManagedRuntimeStatus,
} from "@t3tools/contracts";
import {
  defaultComputeInstallation,
  selectExistingComputeInstallation,
} from "./computeInstallationSettingsModel";

const status: ComputeManagedRuntimeStatus = {
  installed: true,
  selection: "managed",
  updateAvailable: false,
  runtimeVersion: "Python 3.12.13",
  toolkitRevision: null,
  generationId: "g1",
  operation: null,
  failureMessage: null,
};
const inventory: ComputeLanguageRuntimeInventory = {
  descriptor: {
    languageId: ComputeLanguageId.make("python"),
    displayName: "Python",
    sourceExtensions: [".py"],
    capabilities: [],
  },
  enabled: true,
  configuredExecutable: "/system/python",
  managedRuntime: status,
  toolkits: [],
  failureMessage: null,
  installations: [
    { executable: "/managed/python", source: "managed", version: "3.12.13", problem: null },
    {
      executable: "/system/python",
      source: "path",
      version: null,
      problem: null,
      configured: true,
    },
  ],
};

describe("installation selection", () => {
  it("uses managed precedence only for Python, independently of an existing path", () => {
    const preference = { enabled: true, executable: "/system/python" };
    expect(defaultComputeInstallation(inventory, preference, status)?.source).toBe("managed");
    expect(
      defaultComputeInstallation(inventory, preference, { ...status, selection: "existing" })
        ?.source,
    ).toBe("path");
    const matlab = {
      ...inventory,
      descriptor: { ...inventory.descriptor, languageId: ComputeLanguageId.make("matlab") },
    };
    expect(defaultComputeInstallation(matlab, preference, status)?.source).toBe("path");
  });

  it("keeps a configured alias selected without changing its system provenance", () => {
    const language = { ...inventory, configuredExecutable: "python3" };
    expect(
      defaultComputeInstallation(language, { enabled: true, executable: "python3" }, null)
        ?.executable,
    ).toBe("/system/python");
    expect(
      defaultComputeInstallation(language, { enabled: true, executable: "/new/python" }, null),
    ).toBeUndefined();
  });

  it("never labels an alternative as default when an explicit choice disappeared", () => {
    expect(
      defaultComputeInstallation(inventory, { enabled: true, executable: "/missing/python" }, null),
    ).toBeUndefined();
    expect(
      defaultComputeInstallation(
        { ...inventory, installations: inventory.installations.slice(1) },
        { enabled: true, executable: "" },
        status,
      ),
    ).toBeUndefined();
  });

  it("automatic excludes installed-but-unselected managed Python", () => {
    expect(
      defaultComputeInstallation(
        { ...inventory, configuredExecutable: null },
        { enabled: true, executable: "" },
        { ...status, selection: "existing" },
      )?.executable,
    ).toBe("/system/python");
    expect(
      defaultComputeInstallation(
        {
          ...inventory,
          configuredExecutable: null,
          installations: inventory.installations.slice(0, 1),
        },
        { enabled: true, executable: "" },
        { ...status, selection: "existing" },
      ),
    ).toBeUndefined();
  });

  it("does not reuse stale explicit candidate order while automatic discovery refreshes", () => {
    expect(
      defaultComputeInstallation(inventory, { enabled: true, executable: "" }, null),
    ).toBeUndefined();
  });

  it.each(["/system/python", ""])(
    "saves %s before releasing managed precedence",
    async (executable) => {
      const steps: string[] = [];
      await selectExistingComputeInstallation({
        executable,
        preference: { enabled: true, executable: "old" },
        releaseManaged: true,
        save: async (next) => {
          steps.push(`save:${next.executable}`);
          return true;
        },
        useExisting: async () => {
          steps.push("release");
        },
      });
      expect(steps).toEqual([`save:${executable}`, "release"]);
    },
  );

  it("does not release the managed installation after a failed settings save", async () => {
    const release = vi.fn();
    await expect(
      selectExistingComputeInstallation({
        executable: "/system/python",
        preference: { enabled: true, executable: "" },
        releaseManaged: true,
        save: async () => false,
        useExisting: release,
      }),
    ).rejects.toThrow("Settings were not saved");
    expect(release).not.toHaveBeenCalled();
  });

  it("reports a rejected managed release instead of claiming selection succeeded", async () => {
    await expect(
      selectExistingComputeInstallation({
        executable: "/system/python",
        preference: { enabled: true, executable: "" },
        releaseManaged: true,
        save: async () => true,
        useExisting: async () => {
          throw new Error("operation in progress");
        },
      }),
    ).rejects.toThrow("operation in progress");
  });

  it("leaves MATLAB helper selection alone when selecting an installation", async () => {
    const release = vi.fn();
    await selectExistingComputeInstallation({
      executable: "/MATLAB/bin/matlab",
      preference: { enabled: false, executable: "" },
      releaseManaged: false,
      save: async (next) => {
        expect(next.enabled).toBe(false);
        return true;
      },
      useExisting: release,
    });
    expect(release).not.toHaveBeenCalled();
  });
});
