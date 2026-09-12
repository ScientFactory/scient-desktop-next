import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { recoveryFixtures } from "./mermaidRecovery.fixtures";

const native = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: native }));
const good = { svg: '<svg><g id="node" /></svg>', diagramType: "flowchart-v2" };
const syntaxError = () => new Error("Parse error on line 3:\nOriginal source diagnostic");

describe("Mermaid runtime recovery transaction", () => {
  beforeEach(() => {
    vi.resetModules();
    native.render.mockReset();
    native.initialize.mockReset();
  });
  it("renders all compatible fixes together, caches their provenance and rebases each consumer", async () => {
    const fixture = recoveryFixtures.find((entry) => entry.name === "multiple independent issues")!;
    native.render.mockRejectedValueOnce(syntaxError()).mockResolvedValue(good);
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const copies = await Promise.all(
      Array.from({ length: 48 }, () => renderMermaidDiagram(fixture.source, "light")),
    );
    expect(native.render.mock.calls.map((call) => call[1])).toEqual([
      fixture.source,
      fixture.expected,
    ]);
    expect(native.initialize).toHaveBeenCalledTimes(2);
    expect(copies.every((copy) => copy.recovery?.source === fixture.expected)).toBe(true);
    expect(copies[0]?.recovery?.originalSource).toBe(fixture.source);
    expect(new Set(copies.map((copy) => copy.svg)).size).toBe(48);
    await renderMermaidDiagram(fixture.source, "light");
    expect(native.render).toHaveBeenCalledTimes(2);
  });
  it.each([syntaxError(), new Error("Layout failed"), null])(
    "rolls back the entire candidate when rendering fails (%s)",
    async (failure) => {
      const fixture = recoveryFixtures[0];
      const original = syntaxError();
      native.render.mockRejectedValueOnce(original);
      if (failure) native.render.mockRejectedValueOnce(failure);
      else native.render.mockResolvedValueOnce({ ...good, svg: "invalid SVG" });
      const { renderMermaidDiagram } = await import("./mermaidRuntime");
      await expect(renderMermaidDiagram(fixture.source, "light")).rejects.toMatchObject({
        cause: original,
        details: original.message,
      });
      expect(native.render).toHaveBeenCalledTimes(2);
      // Failed candidates are not successes in cache and do not poison the queue.
      native.render.mockResolvedValue(good);
      const result = await renderMermaidDiagram(fixture.source, "light");
      expect(result.recovery).toBeUndefined();
      expect(native.render).toHaveBeenCalledTimes(3);
    },
  );
  it("does not plan/rewrite successfully rendered source even when a rule could match", async () => {
    native.render.mockResolvedValue(good);
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    const fixture = recoveryFixtures[0];
    expect((await renderMermaidDiagram(fixture.source, "light")).recovery).toBeUndefined();
    expect(native.render.mock.calls.map((call) => call[1])).toEqual([fixture.source]);
  });
  it("does not retry layout/resource failures and keeps theme caches separate", async () => {
    const { renderMermaidDiagram } = await import("./mermaidRuntime");
    native.render.mockRejectedValueOnce(new Error("Maximum number of edges exceeded"));
    await expect(renderMermaidDiagram(recoveryFixtures[0].source, "light")).rejects.toThrow(
      "Maximum number",
    );
    expect(native.render).toHaveBeenCalledTimes(1);
    native.render.mockResolvedValue(good);
    await renderMermaidDiagram(recoveryFixtures[0].source, "dark");
    expect(native.render).toHaveBeenCalledTimes(2);
  });
});
