import type { ComputeProjectedOutput } from "@t3tools/contracts";

const COMPUTE_TABLE_MEDIA_TYPE = "application/vnd.dataresource+json";
const COMPUTE_PLOTLY_MEDIA_TYPE = "application/vnd.plotly.v1+json";
const MAX_COMPUTE_TABLE_ROWS = 100;
const MAX_COMPUTE_TABLE_COLUMNS = 24;
const MAX_CELL_TEXT = 512;
const MAX_RICH_SOURCE = 1_000_000;

type RepresentationOutput = Extract<ComputeProjectedOutput, { readonly _tag: "representation" }>;
type Cell = string | number | boolean | null;
export interface ComputeTablePreview {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<Cell>>;
  readonly truncated: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate before creating a bounded DOM; never render arbitrary HTML or nested objects. */
export function parseComputeTable(source: string): ComputeTablePreview | null {
  if (source.length > MAX_RICH_SOURCE) return null;
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return null;
  }
  if (
    !record(value) ||
    !record(value.schema) ||
    !Array.isArray(value.schema.fields) ||
    !Array.isArray(value.data)
  )
    return null;
  const fields = value.schema.fields;
  if (fields.length === 0 || fields.length > 1024) return null;
  const names = fields.map((field: unknown) => (record(field) ? field.name : null));
  if (
    names.some((name) => typeof name !== "string" || name.length === 0 || name.length > 256) ||
    new Set(names).size !== names.length
  )
    return null;
  const columns = names.slice(0, MAX_COMPUTE_TABLE_COLUMNS) as string[];
  let truncated =
    fields.length > columns.length ||
    value.data.length > MAX_COMPUTE_TABLE_ROWS ||
    (record(value.scientPreview) && value.scientPreview.truncated === true);
  const rows: Cell[][] = [];
  for (const row of value.data.slice(0, MAX_COMPUTE_TABLE_ROWS)) {
    if (!record(row)) return null;
    const cells: Cell[] = [];
    for (const column of columns) {
      const cell = Object.hasOwn(row, column) ? row[column] : null;
      if (cell === null || typeof cell === "boolean") cells.push(cell);
      else if (typeof cell === "number" && Number.isFinite(cell)) cells.push(cell);
      else if (typeof cell === "string") {
        if (cell.length > MAX_CELL_TEXT) truncated = true;
        cells.push(cell.length > MAX_CELL_TEXT ? cell.slice(0, MAX_CELL_TEXT) + "…" : cell);
      } else return null;
    }
    rows.push(cells);
  }
  return { columns, rows, truncated };
}

export type ComputeRichRepresentation =
  | { readonly kind: "table"; readonly table: ComputeTablePreview }
  | { readonly kind: "plotly"; readonly source: string };

/** Only inline, bounded data is eligible. Resource-backed output keeps its existing fallback. */
export function computeRichRepresentation(
  output: RepresentationOutput,
): ComputeRichRepresentation | null {
  for (const mediaType of [COMPUTE_TABLE_MEDIA_TYPE, COMPUTE_PLOTLY_MEDIA_TYPE]) {
    const representation = output.bundle.representations.find(
      (item) => item.mediaType === mediaType,
    );
    if (representation?.data._tag !== "json") continue;
    const source = representation.data.json;
    if (source.length > MAX_RICH_SOURCE) continue;
    if (mediaType === COMPUTE_TABLE_MEDIA_TYPE) {
      const table = parseComputeTable(source);
      if (table !== null) return { kind: "table", table };
    } else {
      // PlotlyChartCard owns Plotly validation, resource policy, limits and recoverable errors.
      return { kind: "plotly", source };
    }
  }
  return null;
}
