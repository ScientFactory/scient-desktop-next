import { createFileRoute } from "@tanstack/react-router";

import { ScientificComputingSettings } from "../scient/compute/ScientificComputingSettings";

export const Route = createFileRoute("/settings/scientific-computing")({
  component: ScientificComputingSettings,
});
