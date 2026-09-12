import type {
  ComputeGatewayError,
  ComputeOperationError,
  ComputeRuntimeInventory,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as WorkspaceFileSystem from "../../../workspace/WorkspaceFileSystem.ts";
import * as ScientificRuntimePreferences from "../../../scient/compute/ScientificRuntimePreferences.ts";
import { makeComputeRpcGateway } from "../../../scient/compute/ComputeRpcGateway.ts";
import * as ComputeSessionService from "../../../scient/compute/ComputeSessionService.ts";

export interface ComputeMcpGatewayShape {
  readonly runtimeInventory: () => Effect.Effect<
    ComputeRuntimeInventory,
    ComputeGatewayError | ComputeOperationError
  >;
}

export class ComputeMcpGateway extends Context.Service<ComputeMcpGateway, ComputeMcpGatewayShape>()(
  "t3/mcp/toolkits/compute/ComputeMcpGateway",
) {}

/**
 * The MCP read path deliberately uses the same gateway operation as Settings.
 * It has no project or session input, and therefore cannot select or attach to
 * a cross-project Compute session.
 */
export const ComputeMcpGatewayLive = Layer.effect(
  ComputeMcpGateway,
  Effect.gen(function* () {
    const gateway = makeComputeRpcGateway({
      compute: yield* ComputeSessionService.ComputeSessionService,
      serverSettings: yield* ScientificRuntimePreferences.ScientificRuntimePreferences,
      workspaceFileSystem: yield* WorkspaceFileSystem.WorkspaceFileSystem,
    });
    return ComputeMcpGateway.of({
      runtimeInventory: gateway.runtimeInventory,
    });
  }),
);
