import { projectComputeOutputs, type ComputeOutput } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { ComputeTable } from "./ComputeRichOutput";
import { computeRichRepresentation, parseComputeTable } from "./computeRichRepresentation";

const tableSource = (
  data: unknown = [{ name: "<script>alert(1)</script>", value: 42 }],
  fields: unknown = [{ name: "name" }, { name: "value" }],
) => JSON.stringify({ schema: { fields }, data });

describe("bounded shared Compute representations", () => {
  it("renders scalar table values as text, never HTML", () => {
    const table = parseComputeTable(tableSource())!;
    const markup = renderToStaticMarkup(<ComputeTable table={table} />);
    expect(markup).toContain("&lt;script&gt;");
    expect(markup).not.toContain("<script>");
  });

  it("limits rows, columns and individual cells with a truthful preview label", () => {
    const fields = Array.from({ length: 30 }, (_, index) => ({ name: String(index) }));
    const row = Object.fromEntries(
      fields.map(({ name }) => [name, name === "0" ? "x".repeat(600) : "short"]),
    );
    const table = parseComputeTable(tableSource(Array(150).fill(row), fields))!;
    expect(table.rows).toHaveLength(100);
    expect(table.columns).toHaveLength(24);
    expect(table.rows[0]?.[0]).toHaveLength(513);
    expect(table.truncated).toBe(true);
    expect(renderToStaticMarkup(<ComputeTable table={table} />)).toContain("Limited preview");
  });

  it.each([
    "not JSON",
    "x".repeat(1_000_001),
    JSON.stringify({ schema: {}, data: [] }),
    tableSource([], [{ name: "a" }, { name: "a" }]),
    tableSource([{ name: { nested: true } }]),
    tableSource([["not a record"]]),
    tableSource([], [{ name: "x".repeat(257) }]),
  ])("rejects unsupported table payloads without throwing", (source) => {
    expect(parseComputeTable(source)).toBeNull();
  });

  it("keeps empty tables, missing values and mixed-direction text useful", () => {
    expect(parseComputeTable(tableSource([]))?.rows).toEqual([]);
    expect(parseComputeTable(tableSource([{ name: "שלום / hello" }]))?.rows).toEqual([
      ["שלום / hello", null],
    ]);
  });

  it("does not read prototype properties as row data", () => {
    expect(parseComputeTable(tableSource([{}], [{ name: "toString" }]))?.rows).toEqual([[null]]);
  });

  it("preserves producer-side truncation", () => {
    expect(
      parseComputeTable(
        JSON.stringify({
          schema: { fields: [{ name: "x" }] },
          data: [{ x: 1 }],
          scientPreview: { truncated: true },
        }),
      )?.truncated,
    ).toBe(true);
  });

  it("selects the latest display update, not a stale chart or table snapshot", () => {
    const events: ComputeOutput[] = [
      {
        _tag: "display-data",
        sequence: 1,
        observedAt: "2026-08-31T00:00:00Z",
        displayId: "result",
        bundle: {
          representations: [
            {
              mediaType: "application/vnd.dataresource+json",
              data: { _tag: "json", json: tableSource() },
            },
          ],
          metadataJson: null,
        },
      },
      {
        _tag: "display-update",
        sequence: 2,
        observedAt: "2026-08-31T00:00:01Z",
        displayId: "result",
        bundle: {
          representations: [
            {
              mediaType: "application/vnd.plotly.v1+json",
              data: { _tag: "json", json: '{"data":[{"y":[1,2]}]}' },
            },
          ],
          metadataJson: null,
        },
      },
    ];
    const projected = projectComputeOutputs(events);
    expect(projected).toHaveLength(1);
    const output = projected[0];
    if (output?._tag !== "representation") throw new Error("Expected representation");
    expect(computeRichRepresentation(output)).toEqual({
      kind: "plotly",
      source: '{"data":[{"y":[1,2]}]}',
    });
    expect(
      projectComputeOutputs([
        ...events,
        { _tag: "clear-output", sequence: 3, observedAt: "2026-08-31T00:00:02Z", wait: false },
      ]),
    ).toEqual([]);
  });
});
