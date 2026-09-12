import { lazy, Suspense } from "react";
import { useTheme } from "~/hooks/useTheme";
import type { ComputeRichRepresentation, ComputeTablePreview } from "./computeRichRepresentation";

const PlotlyChartCard = lazy(() =>
  import("~/scient/visualizations/PlotlyChartCard").then((module) => ({
    default: module.PlotlyChartCard,
  })),
);

export function ComputeTable(props: { readonly table: ComputeTablePreview }) {
  return (
    <figure className="min-w-0 overflow-hidden rounded-md border border-border/70">
      <div className="max-h-80 overflow-auto">
        <table className="w-full border-collapse text-xs" aria-label="Result table">
          <thead className="sticky top-0 bg-muted">
            <tr>
              {props.table.columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="border-b border-border/60 px-3 py-1.5 text-start font-medium"
                  dir="auto"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {props.table.rows.map((row, index) => (
              // eslint-disable-next-line react/no-array-index-key -- Immutable output rows can be identical and have no persistent row identity.
              <tr key={index} className="border-b border-border/40 last:border-b-0">
                {row.map((cell, column) => (
                  <td
                    key={props.table.columns[column]}
                    className={
                      typeof cell === "number"
                        ? "px-3 py-1.5 text-end tabular-nums"
                        : "max-w-64 break-words px-3 py-1.5"
                    }
                    dir="auto"
                  >
                    {cell === null ? "—" : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <figcaption className="border-t border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground">
        {props.table.rows.length} rows · {props.table.columns.length} columns
        {props.table.truncated ? " · Limited preview" : ""}
      </figcaption>
    </figure>
  );
}

export function ComputeRichOutput(props: { readonly representation: ComputeRichRepresentation }) {
  const { resolvedTheme } = useTheme();
  return props.representation.kind === "table" ? (
    <ComputeTable table={props.representation.table} />
  ) : (
    <Suspense
      fallback={<p className="text-xs text-muted-foreground">Loading interactive figure…</p>}
    >
      <PlotlyChartCard
        language="plotly"
        source={props.representation.source}
        theme={resolvedTheme}
        title={null}
      />
    </Suspense>
  );
}
