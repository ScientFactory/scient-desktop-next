import { createComputeEnvironmentAtoms } from "@t3tools/client-runtime/state/compute";

import { connectionAtomRuntime } from "../connection/runtime";

export const computeEnvironment = createComputeEnvironmentAtoms(connectionAtomRuntime);
