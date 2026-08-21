import { describe, expect, it } from "vite-plus/test";

import {
  clampScientSplitFraction,
  nudgeScientSplitFraction,
  scientSplitFractionFromPointer,
} from "./scientSplitFraction";

const BOUNDS = { minimum: 0.2, fallback: 0.5 } as const;

describe("Scient fractional split", () => {
  it("clamps fractions without inventing a fallback for finite input", () => {
    expect(clampScientSplitFraction(Number.NaN, BOUNDS)).toBe(0.5);
    expect(clampScientSplitFraction(0.1, BOUNDS)).toBe(0.2);
    expect(clampScientSplitFraction(0.9, BOUNDS)).toBe(0.8);
    expect(clampScientSplitFraction(0.42, BOUNDS)).toBe(0.42);
  });

  it("maps pointer positions to the same bounded fraction for every surface", () => {
    expect(scientSplitFractionFromPointer({ pointerX: 500, left: 100, width: 800 }, BOUNDS)).toBe(
      0.5,
    );
    expect(scientSplitFractionFromPointer({ pointerX: 0, left: 0, width: 0 }, BOUNDS)).toBe(0.5);
    expect(scientSplitFractionFromPointer({ pointerX: 0, left: 100, width: 800 }, BOUNDS)).toBe(
      0.2,
    );
  });

  it("maps vertical pointer positions to bounded fractions", () => {
    expect(scientSplitFractionFromPointer({ pointerY: 300, top: 100, height: 400 }, BOUNDS)).toBe(
      0.5,
    );
    expect(scientSplitFractionFromPointer({ pointerY: 0, top: 0, height: 0 }, BOUNDS)).toBe(0.5);
    expect(scientSplitFractionFromPointer({ pointerY: 0, top: 100, height: 400 }, BOUNDS)).toBe(
      0.2,
    );
  });

  it("supports bounded keyboard movement and leaves unrelated keys alone", () => {
    expect(nudgeScientSplitFraction(0.5, "ArrowLeft", BOUNDS, 0.02)).toBe(0.48);
    expect(nudgeScientSplitFraction(0.5, "ArrowRight", BOUNDS, 0.02)).toBe(0.52);
    expect(nudgeScientSplitFraction(0.5, "ArrowUp", BOUNDS, 0.02)).toBeNull();
    expect(nudgeScientSplitFraction(0.5, "ArrowDown", BOUNDS, 0.02)).toBeNull();
    expect(nudgeScientSplitFraction(0.5, "ArrowUp", BOUNDS, 0.02, "y")).toBe(0.48);
    expect(nudgeScientSplitFraction(0.5, "ArrowDown", BOUNDS, 0.02, "y")).toBe(0.52);
    expect(nudgeScientSplitFraction(0.5, "ArrowLeft", BOUNDS, 0.02, "y")).toBeNull();
    expect(nudgeScientSplitFraction(0.5, "Home", BOUNDS, 0.02)).toBe(0.2);
    expect(nudgeScientSplitFraction(0.5, "End", BOUNDS, 0.02)).toBe(0.8);
    expect(nudgeScientSplitFraction(0.5, "Enter", BOUNDS, 0.02)).toBeNull();
  });
});
