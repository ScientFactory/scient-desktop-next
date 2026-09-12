import { ComputeLanguageId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ServerSettingsService, layerTest } from "../../serverSettings.ts";
import { makeScientificRuntimePreferences } from "./ScientificRuntimePreferences.ts";

const MATLAB = ComputeLanguageId.make("matlab");
const PYTHON = ComputeLanguageId.make("python");

describe("scientific runtime preference ownership", () => {
  it.effect("reads a legacy MATLAB choice without rewriting it or enabling compute", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const legacy = vi.fn(() =>
        Effect.succeed({ executablePath: "/legacy/matlab", warning: null }),
      );
      const preferences = makeScientificRuntimePreferences(settings, {
        readRuntimeExecutablePath: legacy,
      });
      expect((yield* preferences.getSettings).scientificComputing.languages[MATLAB]).toEqual({
        enabled: false,
        executable: "/legacy/matlab",
      });
      expect((yield* settings.getSettings).scientificComputing.languages[MATLAB]).toBeUndefined();
      expect(yield* preferences.readRuntimeExecutablePath("matlab")).toEqual({
        executablePath: "/legacy/matlab",
        warning: null,
      });
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("makes both execution paths observe canonical updates and an explicit clear", () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      const legacy = vi.fn(() =>
        Effect.succeed({ executablePath: "/legacy/matlab", warning: null }),
      );
      const preferences = makeScientificRuntimePreferences(settings, {
        readRuntimeExecutablePath: legacy,
      });
      yield* preferences.writeRuntimeExecutablePath("matlab", "/selected/matlab");
      expect((yield* settings.getSettings).scientificComputing.languages[MATLAB]?.executable).toBe(
        "/selected/matlab",
      );
      yield* settings.updateSettings({
        scientificComputing: { languages: { [MATLAB]: { executable: "/changed/matlab" } } },
      });
      expect((yield* preferences.readRuntimeExecutablePath("matlab")).executablePath).toBe(
        "/changed/matlab",
      );
      yield* preferences.writeRuntimeExecutablePath("matlab", null);
      expect((yield* preferences.readRuntimeExecutablePath("matlab")).executablePath).toBeNull();
      expect(legacy).not.toHaveBeenCalled();
      expect((yield* settings.getSettings).scientificComputing.languages[PYTHON]).toEqual({
        enabled: true,
        executable: "/chosen/python",
      });
    }).pipe(
      Effect.provide(
        layerTest({
          scientificComputing: {
            languages: { [PYTHON]: { enabled: true, executable: "/chosen/python" } },
          },
        }),
      ),
    ),
  );
});
