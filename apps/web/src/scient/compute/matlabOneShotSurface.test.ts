import { describe, expect, it } from "vite-plus/test";

import {
  hideMatlabOneShotSurface,
  isMatlabOneShotSurfaceVisible,
  showMatlabOneShotSurface,
} from "./matlabOneShotSurface";

describe("matlab one-shot surface", () => {
  it("stays hidden until a file explicitly asks for the fresh-process panel", () => {
    expect(isMatlabOneShotSurfaceVisible("analysis.m")).toBe(false);
    showMatlabOneShotSurface("analysis.m");
    expect(isMatlabOneShotSurfaceVisible("analysis.m")).toBe(true);
    expect(isMatlabOneShotSurfaceVisible("other.m")).toBe(false);
    hideMatlabOneShotSurface("analysis.m");
    expect(isMatlabOneShotSurfaceVisible("analysis.m")).toBe(false);
  });
});
