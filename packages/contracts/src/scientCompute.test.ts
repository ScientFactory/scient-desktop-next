import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ComputeManagedRuntimeStatus, ComputeRuntimeInstallation } from "@scientfactory/compute";

import { ComputeRuntimeInspection, ComputeRuntimeInventory } from "./scientCompute.ts";

const decodeRuntimeInspection = Schema.decodeUnknownSync(ComputeRuntimeInspection);
const decodeRuntimeInventory = Schema.decodeUnknownSync(ComputeRuntimeInventory);

describe("scient compute contracts", () => {
  it("keeps installation-selection and helper-ownership metadata optional for older payloads", () => {
    const installation = {
      executable: "/system/python",
      source: "path",
      version: null,
      problem: null,
    };
    const decodeInstallation = Schema.decodeUnknownSync(ComputeRuntimeInstallation);
    expect(decodeInstallation(installation)).not.toHaveProperty("configured");
    expect(decodeInstallation({ ...installation, configured: true })).toMatchObject({
      source: "path",
      configured: true,
    });
    const helper = {
      installed: true,
      selection: "managed",
      updateAvailable: false,
      runtimeVersion: "3.12.13",
      toolkitRevision: null,
      operation: null,
      failureMessage: null,
    };
    const decodeHelper = Schema.decodeUnknownSync(ComputeManagedRuntimeStatus);
    expect(decodeHelper(helper)).not.toHaveProperty("installationExecutable");
    expect(
      decodeHelper({ ...helper, installationExecutable: "/MATLAB/bin/matlab" })
        .installationExecutable,
    ).toBe("/MATLAB/bin/matlab");
  });
  it("represents installation presence without inventing execution readiness", () => {
    const inventory = decodeRuntimeInventory({
      languages: [
        {
          descriptor: {
            languageId: "python",
            displayName: "Python",
            sourceExtensions: [".py"],
            capabilities: ["execute"],
          },
          enabled: true,
          configuredExecutable: null,
          managedRuntime: null,
          toolkits: [],
          failureMessage: null,
          installations: [{ executable: "/python", source: "path", version: null, problem: null }],
        },
      ],
    });
    expect(inventory.languages[0]?.installations[0]?.version).toBeNull();
    expect(inventory.languages[0]).not.toHaveProperty("runtimes");
    expect(inventory.languages[0]?.installations[0]).not.toHaveProperty("readiness");
    expect(() => decodeRuntimeInspection(inventory)).toThrow();
  });
  it("keeps pre-Toolkit runtime-inspection payloads readable", () => {
    const inspection = decodeRuntimeInspection({
      contractVersion: 1,
      scope: "environment",
      languages: [
        {
          descriptor: {
            languageId: "python",
            displayName: "Python",
            sourceExtensions: [".py"],
            capabilities: ["execute"],
          },
          enabled: true,
          configuredExecutable: null,
          runtimes: [
            {
              profile: {
                languageId: "python",
                source: "path",
                executable: "/usr/bin/python3",
                languageVersion: "3.12.0",
                architecture: "arm64",
                displayName: "Python 3.12.0",
              },
              verification: {
                profile: {
                  languageId: "python",
                  source: "path",
                  executable: "/usr/bin/python3",
                  languageVersion: "3.12.0",
                  architecture: "arm64",
                  displayName: "Python 3.12.0",
                },
                readiness: "ready",
                missingRequirements: [],
                message: null,
              },
            },
          ],
        },
      ],
    });

    expect(inspection.languages[0]?.toolkits).toEqual([]);
    expect(inspection.languages[0]?.runtimes[0]?.toolkits).toEqual([]);
    expect(inspection.languages[0]?.runtimes[0]?.verification.packages).toEqual([]);
  });
});
