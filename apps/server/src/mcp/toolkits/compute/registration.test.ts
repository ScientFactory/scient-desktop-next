import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { ScientComputeToolkitRegistrationLive } from "../../McpHttpServer.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";

const TestLayer = ScientComputeToolkitRegistrationLive.pipe(
  Layer.provide(
    Layer.succeed(ComputeMcpGateway, {
      runtimeInventory: () => Effect.succeed({ languages: [] }),
    }),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers an object-shaped read-only Compute inventory tool", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const registered = server.tools.find(({ tool }) => tool.name === "scient_compute_inventory");

    expect(registered?.tool.inputSchema.type).toBe("object");
    expect(registered?.tool.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  }).pipe(Effect.provide(TestLayer)),
);
