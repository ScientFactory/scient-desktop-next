export interface ScientSplitFractionBounds {
  readonly minimum: number;
  readonly fallback: number;
}

export type ScientSplitAxis = "x" | "y";

export function clampScientSplitFraction(value: number, bounds: ScientSplitFractionBounds): number {
  if (!Number.isFinite(value)) return bounds.fallback;
  return Math.min(Math.max(value, bounds.minimum), 1 - bounds.minimum);
}

export function scientSplitFractionFromPointer(
  input:
    | {
        readonly pointerX: number;
        readonly left: number;
        readonly width: number;
      }
    | {
        readonly pointerY: number;
        readonly top: number;
        readonly height: number;
      },
  bounds: ScientSplitFractionBounds,
): number {
  if ("pointerY" in input) {
    if (input.height <= 0) return bounds.fallback;
    return clampScientSplitFraction((input.pointerY - input.top) / input.height, bounds);
  }
  if (input.width <= 0) return bounds.fallback;
  return clampScientSplitFraction((input.pointerX - input.left) / input.width, bounds);
}

export function nudgeScientSplitFraction(
  current: number,
  key: string,
  bounds: ScientSplitFractionBounds,
  step: number,
  axis: ScientSplitAxis = "x",
): number | null {
  if (axis === "y") {
    switch (key) {
      case "ArrowUp":
        return clampScientSplitFraction(current - step, bounds);
      case "ArrowDown":
        return clampScientSplitFraction(current + step, bounds);
      case "Home":
        return bounds.minimum;
      case "End":
        return 1 - bounds.minimum;
      default:
        return null;
    }
  }
  switch (key) {
    case "ArrowLeft":
      return clampScientSplitFraction(current - step, bounds);
    case "ArrowRight":
      return clampScientSplitFraction(current + step, bounds);
    case "Home":
      return bounds.minimum;
    case "End":
      return 1 - bounds.minimum;
    default:
      return null;
  }
}
