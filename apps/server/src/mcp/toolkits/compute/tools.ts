import { ComputeRuntimeInventory } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";

// MCP clients require an object schema even when a read operation has no
// arguments. This rejects arrays and scalar payloads instead of publishing a
// broad JSON schema that can cause a client to discard the tool catalog.
const EmptyToolInput = Schema.Record(Schema.String, Schema.Never);
const dependencies = [McpInvocationContext.McpInvocationContext, ComputeMcpGateway];

export class ScientComputeInventoryToolError extends Schema.TaggedError<ScientComputeInventoryToolError>()(
  "ScientComputeInventoryToolError",
  {
    code: Schema.Literals(["capability-unavailable", "inventory-failed"]),
    message: Schema.Trimmed.check(Schema.isNonEmpty()),
  },
) {}

const ScientComputeInventoryTool = Tool.make("scient_compute_inventory", {
  description:
    "Read the bounded Scient Compute runtime inventory for the server. It distinguishes configured settings, managed-runtime status, and existing runtime candidates. This is read-only discovery: readiness is unknown unless a separate verified result says otherwise; it never installs, runs, executes, or attaches to a runtime or project session.",
  parameters: EmptyToolInput,
  success: ComputeRuntimeInventory,
  failure: ScientComputeInventoryToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Scient Compute runtimes")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const ScientComputeToolkit = Toolkit.make(ScientComputeInventoryTool);
