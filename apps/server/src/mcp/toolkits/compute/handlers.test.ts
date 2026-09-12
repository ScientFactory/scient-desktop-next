import {
  ComputeGatewayError,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ComputeMcpGateway } from "./ComputeMcpGateway.ts";
import { listScientComputeInventory } from "./handlers.ts";
import { ScientComputeInventoryToolError } from "./tools.ts";

const makeInvocation = (
  capabilities: ReadonlySet<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-compute-handler-test"),
  threadId: ThreadId.make("thread-compute-handler-test"),
  providerSessionId: "provider-session-compute-handler-test",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

it.effect("requires compute:read before touching the gateway", () => {
  const runtimeInventory = vi.fn(() => Effect.succeed({ languages: [] }));
  const gateway = { runtimeInventory } satisfies ComputeMcpGateway["Service"];

  return Effect.gen(function* () {
    const error = yield* listScientComputeInventory().pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, makeInvocation(new Set())),
      Effect.provideService(ComputeMcpGateway, gateway),
      Effect.flip,
    );

    expect(error).toBeInstanceOf(ScientComputeInventoryToolError);
    expect(error).toMatchObject({ code: "capability-unavailable" });
    expect(runtimeInventory).not.toHaveBeenCalled();
  });
});

it.effect("reads only the existing gateway inventory operation", () => {
  const inventory = { languages: [] };
  const runtimeInventory = vi.fn(() => Effect.succeed(inventory));
  const gateway = { runtimeInventory } satisfies ComputeMcpGateway["Service"];

  return Effect.gen(function* () {
    const result = yield* listScientComputeInventory().pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeInvocation(new Set(["compute:read"])),
      ),
      Effect.provideService(ComputeMcpGateway, gateway),
    );

    expect(result).toEqual(inventory);
    expect(runtimeInventory).toHaveBeenCalledTimes(1);
  });
});

it.effect("maps gateway failures without exposing host details", () => {
  const runtimeInventory = vi.fn(() =>
    Effect.fail(
      new ComputeGatewayError({
        operation: "inspect",
        reason: "operation-failed",
        message: "host-specific-runtime should not be returned",
      }),
    ),
  );
  const gateway = { runtimeInventory } satisfies ComputeMcpGateway["Service"];

  return Effect.gen(function* () {
    const error = yield* listScientComputeInventory().pipe(
      Effect.provideService(
        McpInvocationContext.McpInvocationContext,
        makeInvocation(new Set(["compute:read"])),
      ),
      Effect.provideService(ComputeMcpGateway, gateway),
      Effect.flip,
    );

    expect(error).toMatchObject({ code: "inventory-failed" });
    expect(error.message).not.toContain("host-specific-runtime");
  });
});
