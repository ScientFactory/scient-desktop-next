import { createFileRoute } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { ScientificComputingSettings } from "../scient/compute/ScientificComputingSettings";

export const Route = createFileRoute("/settings/scientific-computing")({
  validateSearch: Schema.decodeUnknownSync(
    Schema.Struct({ environmentId: Schema.optionalKey(EnvironmentId) }),
  ),
  component: () => <ScientificComputingSettings environmentId={Route.useSearch().environmentId} />,
});
