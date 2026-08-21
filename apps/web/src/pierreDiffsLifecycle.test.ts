// @effect-diagnostics nodeBuiltinImport:off -- verifies the installed dependency patch.
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

const pierrePackage = NodeFS.realpathSync(
  new URL("../node_modules/@pierre/diffs", import.meta.url),
);
const filePreviewSource = NodeFS.readFileSync(
  new URL("./components/files/FilePreviewPanel.tsx", import.meta.url),
  "utf8",
);

const instanceHooks = [
  "useFileInstance.js",
  "useFileDiffInstance.js",
  "useUnresolvedFileInstance.js",
] as const;

describe("Pierre file instance lifecycle", () => {
  it.each(instanceHooks)("makes %s detach idempotent and reentrancy-safe", (hookName) => {
    const source = NodeFS.readFileSync(
      new URL(`./dist/react/utils/${hookName}`, `file://${pierrePackage}/`),
      "utf8",
    );

    const capture = source.indexOf("const instance = instanceRef.current;");
    const tolerateRepeatedDetach = source.indexOf("if (instance == null) return;", capture);
    const releaseOwnership = source.indexOf("instanceRef.current = null;", tolerateRepeatedDetach);
    const cleanUp = source.indexOf("instance.cleanUp();", releaseOwnership);

    expect(capture).toBeGreaterThanOrEqual(0);
    expect(tolerateRepeatedDetach).toBeGreaterThan(capture);
    expect(releaseOwnership).toBeGreaterThan(tolerateRepeatedDetach);
    expect(cleanUp).toBeGreaterThan(releaseOwnership);
  });

  it("leaves editor cleanup with the shared EditProvider", () => {
    expect(filePreviewSource).not.toContain("editor.cleanUp();");
    expect(filePreviewSource).toContain("<EditProvider editor={editor}>");
  });
});
