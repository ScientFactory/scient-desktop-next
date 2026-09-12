import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { ScientComputeInventoryToolError, ScientComputeToolkit } from "./tools.ts";

const toolError = (
  code: ConstructorParameters<typeof ScientComputeInventoryToolError>[0]["code"],
  message: string,
) => new ScientComputeInventoryToolError({ code, message });

const requireComputeRead = Effect.fn("ScientComputeToolkit.requireRead")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("compute:read")) {
    return yield* toolError(
      "capability-unavailable",
      "This provider session does not grant read access to Scient Compute inventory.",
    );
  }
  return invocation;
});

export const listScientComputeInventory = Effect.fn("ScientComputeToolkit.inventory")(function* () {
  yield* requireComputeRead();
  const gateway = yield* ComputeMcpGateway;
  return yield* gateway
    .runtimeInventory()
    .pipe(
      Effect.mapError(() =>
        toolError("inventory-failed", "The Scient Compute runtime inventory could not be read."),
      ),
    );
});

const handlers = {
  scient_compute_inventory: () => listScientComputeInventory(),
} satisfies Parameters<typeof ScientComputeToolkit.toLayer>[0];

export const ScientComputeToolkitHandlersLive = ScientComputeToolkit.toLayer(handlers);
