import { describe, expect, it } from "@effect/vitest";

import { previewImageSourceIdentity } from "./PreviewImageSurface";

describe("previewImageSourceIdentity", () => {
  it("keeps one content identity across signed URL renewal", () => {
    expect(
      previewImageSourceIdentity({
        url: "http://127.0.0.1/assets/renewed-token",
        alt: "Figure",
        revisionKey: "analysis-run:42:figure-1",
        loadKey: "retry-2",
      }),
    ).toBe("analysis-run:42:figure-1");
  });

  it("uses the URL as the identity for simple callers", () => {
    expect(previewImageSourceIdentity({ url: "/figure.png", alt: "Figure" })).toBe("/figure.png");
  });
});
