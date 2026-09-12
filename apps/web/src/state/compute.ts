import { createComputeEnvironmentAtoms } from "@t3tools/client-runtime/state/compute";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentId } from "@t3tools/contracts";
import { serverEnvironment } from "./server";

import { connectionAtomRuntime } from "../connection/runtime";

const computeSettings = Atom.family((environmentId: EnvironmentId) =>
  Atom.map(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.scientificComputing,
  ),
);
export const computeEnvironment = createComputeEnvironmentAtoms(
  connectionAtomRuntime,
  computeSettings,
);
