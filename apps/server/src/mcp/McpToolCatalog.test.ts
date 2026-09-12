import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import { ScientDocumentsToolkit } from "./toolkits/documents/tools.ts";
import { ScientComputeToolkit } from "./toolkits/compute/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ScientSkillsToolkit } from "./toolkits/skills/tools.ts";
import { ScientSourcesToolkit } from "./toolkits/sources/tools.ts";

const tools: ReadonlyArray<Tool.Any> = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(ScientSourcesToolkit.tools),
  ...Object.values(ScientSkillsToolkit.tools),
  ...Object.values(ScientDocumentsToolkit.tools),
  ...Object.values(ScientComputeToolkit.tools),
];

it("publishes a provider-compatible MCP tool catalog", () => {
  const names = tools.map((tool) => tool.name);
  expect(new Set(names).size).toBe(names.length);

  for (const tool of tools) {
    const inputSchema = Tool.getJsonSchema(tool) as { readonly type?: unknown };
    expect(inputSchema.type, `${tool.name} must accept a JSON object`).toBe("object");
  }
});
