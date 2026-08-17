import { EnvironmentId } from "@t3tools/contracts";
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
    expect(html).toContain('data-file-breadcrumb-kind="file"');
    expect(html).not.toContain('aria-label="Browse sources/drafts/paper.tex"');
  });
});
