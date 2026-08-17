// @effect-diagnostics nodeBuiltinImport:off -- Static audit for Base UI's required menu-group context.
import { EnvironmentId } from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { FileBreadcrumbNavigator } from "./FileBreadcrumbNavigator";

describe("FileBreadcrumbNavigator", () => {
  it("makes project and directory crumbs browseable while keeping the file crumb static", () => {
    const html = renderToStaticMarkup(
      <FileBreadcrumbNavigator
        environmentId={EnvironmentId.make("breadcrumb-test")}
        cwd="C:\\repo"
        projectName="Scient"
        relativePath="sources/drafts/paper.tex"
        onOpenFile={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="Browse Scient"');
    expect(html).toContain('aria-label="Browse sources"');
    expect(html).toContain('aria-label="Browse sources/drafts"');
    expect(html).toContain('data-current-file-crumb="true"');
    expect(html).not.toContain('aria-label="Browse sources/drafts/paper.tex"');
  });

  it("keeps the Base UI group label inside its required group context", () => {
    const source = NodeFS.readFileSync(
      new URL("./FileBreadcrumbNavigator.tsx", import.meta.url),
      "utf8",
    );
    const groupStart = source.indexOf("<MenuGroup>");
    const label = source.indexOf("<MenuGroupLabel", groupStart);
    const groupEnd = source.indexOf("</MenuGroup>", label);

    expect(groupStart).toBeGreaterThanOrEqual(0);
    expect(label).toBeGreaterThan(groupStart);
    expect(groupEnd).toBeGreaterThan(label);
  });
});
