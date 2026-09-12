import { describe, expect, it } from "vite-plus/test";

import {
  getMermaidRuntimePromise,
  MAX_MERMAID_SOURCE_LENGTH,
  rebaseMermaidSvgIds,
  renderMermaidDiagram,
} from "./mermaidRuntime";

describe("rebaseMermaidSvgIds", () => {
  it("rebases marker, mask, link, style, and accessibility references together", () => {
    const svg = `<svg aria-labelledby="title-id description-id">
      <title id="title-id">Lifecycle</title>
      <desc id='description-id'>A description</desc>
      <defs><marker id="arrow-id"></marker><mask id="mask-id"></mask></defs>
      <style>#node-id{marker-end:url(#arrow-id)}</style>
      <g id="node-id" aria-describedby="description-id" mask="url('#mask-id')">
        <a href="#node-id"><path marker-end="url(#arrow-id)" /></a>
      </g>
    </svg>`;

    const rebased = rebaseMermaidSvgIds(svg, "instance-a");

    expect(rebased).not.toContain('id="title-id"');
    expect(rebased).not.toContain("#arrow-id");
    expect(rebased).not.toContain('aria-labelledby="title-id description-id"');
    expect(rebased).toContain('id="instance-a-0"');
    expect(rebased).toContain('aria-labelledby="instance-a-0 instance-a-1"');
    expect(rebased).toContain("url(#instance-a-2)");
    expect(rebased).toContain("url('#instance-a-3')");
    expect(rebased).toContain('href="#instance-a-4"');
    expect(rebased).toContain('aria-describedby="instance-a-1"');
  });

  it("leaves id-free SVG unchanged", () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M0 0" /></svg>';
    expect(rebaseMermaidSvgIds(svg, "unused")).toBe(svg);
  });
});

describe("renderMermaidDiagram input bounds", () => {
  it("rejects empty source before loading the renderer", async () => {
    await expect(renderMermaidDiagram("  \n", "light")).rejects.toThrow(
      "The diagram source is empty.",
    );
  });

  it("rejects oversized source before loading the renderer", async () => {
    await expect(
      renderMermaidDiagram("x".repeat(MAX_MERMAID_SOURCE_LENGTH + 1), "dark"),
    ).rejects.toThrow("The diagram is too large to render");
  });

  it("recognizes accessibility metadata after the diagram declaration", async () => {
    const { default: mermaid } = await getMermaidRuntimePromise();
    mermaid.initialize({ startOnLoad: false });

    expect(
      mermaid.detectType(`flowchart LR
  accTitle: Compute lifecycle
  accDescr: Source runs and produces a durable result
  source[Source] --> result[Result]`),
    ).toBe("flowchart-v2");
  });

  it("confirms native detection rejects misplaced metadata before Scient's recovery pass", async () => {
    const { default: mermaid } = await getMermaidRuntimePromise();
    mermaid.initialize({ startOnLoad: false });

    expect(() =>
      mermaid.detectType(`accTitle: Compute lifecycle
accDescr: Invalid ordering remains visible to the author
flowchart LR
  source[Source] --> result[Result]`),
    ).toThrow("No diagram type detected");
  });
});
