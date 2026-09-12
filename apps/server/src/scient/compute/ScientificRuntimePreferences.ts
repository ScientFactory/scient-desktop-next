import {
  ComputeLanguageId,
  DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ServerSettingsService } from "../../serverSettings.ts";
import { LocalAnalysisStore } from "../analysis/LocalAnalysisStore.ts";
const MATLAB = ComputeLanguageId.make("matlab");

/** One preference for both MATLAB execution paths. Legacy data is read-only. */
export function makeScientificRuntimePreferences(
  settings: Pick<ServerSettingsService["Service"], "getSettings" | "updateSettings">,
  legacy: Pick<LocalAnalysisStore["Service"], "readRuntimeExecutablePath">,
) {
  const getSettings = Effect.gen(function* () {
    const current = yield* settings.getSettings;
    // Presence is deliberate: an explicitly cleared path means Automatic, not
    // permission to resurrect a superseded legacy path.
    if (current.scientificComputing.languages[MATLAB] !== undefined) return current;
    const previous = yield* legacy.readRuntimeExecutablePath("matlab");
    if (previous.executablePath === null) return current;
    return {
      ...current,
      scientificComputing: {
        ...current.scientificComputing,
        languages: {
          ...current.scientificComputing.languages,
          [MATLAB]: {
            ...DEFAULT_SCIENTIFIC_COMPUTING_LANGUAGE_SETTINGS,
            executable: previous.executablePath,
          },
        },
      },
    };
  });
  return {
    getSettings,
    readRuntimeExecutablePath: (kind: string) =>
      Effect.gen(function* () {
        const current = yield* settings.getSettings;
        const preference = current.scientificComputing.languages[ComputeLanguageId.make(kind)];
        if (kind === "matlab" && preference === undefined)
          return yield* legacy.readRuntimeExecutablePath(kind);
        return { executablePath: preference?.executable || null, warning: null };
      }),
    writeRuntimeExecutablePath: (kind: string, executablePath: string | null) =>
      settings
        .updateSettings({
          scientificComputing: {
            languages: { [ComputeLanguageId.make(kind)]: { executable: executablePath ?? "" } },
          },
        })
        .pipe(Effect.asVoid),
  };
}

export class ScientificRuntimePreferences extends Context.Service<
  ScientificRuntimePreferences,
  ReturnType<typeof makeScientificRuntimePreferences>
>()("t3/scient/compute/ScientificRuntimePreferences") {}

export const layer = Layer.effect(
  ScientificRuntimePreferences,
  Effect.gen(function* () {
    return makeScientificRuntimePreferences(
      yield* ServerSettingsService,
      yield* LocalAnalysisStore,
    );
  }),
);
