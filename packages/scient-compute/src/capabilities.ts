import type { ComputeCapability } from "./contract.ts";

/**
 * What every session needs before it is allowed to run user code.
 *
 * A runtime that cannot be interrupted or restarted is not a session a user can
 * work in: a mistaken loop would only be escapable by killing the process and
 * losing every variable. Refusing to start is a better answer than discovering
 * this from a stop button that does nothing.
 */
export const REQUIRED_COMPUTE_CAPABILITIES: ReadonlySet<ComputeCapability> = new Set([
  "execute",
  "interrupt",
  "restart",
  "shutdown",
]);

/**
 * Which required capabilities a runtime did not offer, in the order they were
 * required so the message a user sees is stable.
 */
export function missingComputeCapabilities(
  offered: ReadonlyArray<ComputeCapability>,
  required: ReadonlySet<ComputeCapability> = REQUIRED_COMPUTE_CAPABILITIES,
): ReadonlyArray<ComputeCapability> {
  const available = new Set(offered);
  return [...required].filter((capability) => !available.has(capability));
}
