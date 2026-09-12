import * as Effect from "effect/Effect";

import * as ComputeProjectOutputObserver from "./ComputeProjectOutputObserver.ts";
import {
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  type ComputeRuntimeBinding,
  layerWithRuntimeBindings,
} from "./ComputeSessionService.ts";
import { matlabRuntimeBinding } from "./MatlabComputeRuntime.ts";
import { pythonRuntimeBinding } from "./PythonComputeRuntime.ts";

function optionalBinding<E, R>(
  label: string,
  binding: Effect.Effect<ComputeRuntimeBinding, E, R>,
): Effect.Effect<ReadonlyArray<ComputeRuntimeBinding>, never, R> {
  return binding.pipe(
    Effect.map((value) => [value]),
    Effect.catch((cause) =>
      Effect.logWarning(`compute runtime '${label}' is unavailable`, {
        reason: String(cause),
      }).pipe(Effect.as([])),
    ),
  );
}

/**
 * Production compute bindings. A missing optional runtime disables only that
 * language; it never prevents the editor or another language from starting.
 */
export const layer = layerWithRuntimeBindings(
  Effect.all(
    [
      optionalBinding("python", pythonRuntimeBinding),
      optionalBinding("matlab", matlabRuntimeBinding),
    ],
    { concurrency: 2 },
  ).pipe(Effect.map((bindings) => bindings.flat())),
  DEFAULT_COMPUTE_SESSION_SERVICE_OPTIONS,
  ComputeProjectOutputObserver.liveLayer,
);
