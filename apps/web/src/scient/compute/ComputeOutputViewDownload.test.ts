import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { ComputeExecutionId, ComputeProjectId, ComputeSessionId } from "@t3tools/contracts";
import { downloadBlob } from "~/components/preview/staticImageActions";
import { downloadComputeNativeFigure } from "./ComputeOutputViewDownload";
import {
  COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
  MAX_COMPUTE_NATIVE_FIGURE_BYTES,
} from "./computeResultPresentation";
import type { ComputeFigureNativeDownload } from "./computeFigurePresentation";

vi.mock("~/components/preview/staticImageActions", () => ({ downloadBlob: vi.fn() }));
const figure: ComputeFigureNativeDownload = {
  fileName: "figure-2.fig",
  byteLength: 4,
  resource: {
    _tag: "compute-output",
    projectId: ComputeProjectId.make("project"),
    sessionId: ComputeSessionId.make("session"),
    executionId: ComputeExecutionId.make("execution"),
    contentHash: "sha256:fig",
  },
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("bounded native FIG downloads", () => {
  it("downloads the authorized native bytes through the existing blob helper", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal("fetch", fetcher);
    await downloadComputeNativeFigure("https://synthetic.invalid/authorized-resource", figure);
    expect(fetcher).toHaveBeenCalledWith(
      "https://synthetic.invalid/authorized-resource",
      expect.objectContaining({ cache: "no-store", mode: "cors" }),
    );
    const [blob, fileName] = vi.mocked(downloadBlob).mock.calls[0]!;
    expect(fileName).toBe("figure-2.fig");
    expect(blob.type).toBe(COMPUTE_NATIVE_FIGURE_MEDIA_TYPE);
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  it.each([0, MAX_COMPUTE_NATIVE_FIGURE_BYTES + 1])(
    "rejects invalid advertised size %s before fetching",
    async (byteLength) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        downloadComputeNativeFigure("https://synthetic.invalid/resource", {
          ...figure,
          byteLength,
        }),
      ).rejects.toThrow("limit");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([3, 5])(
    "rejects response size %s instead of saving a partial or oversized FIG",
    async (size) => {
      const cancel = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new Uint8Array(size));
                if (size < 4) controller.close();
              },
              cancel,
            }),
          ),
        ),
      );
      await expect(
        downloadComputeNativeFigure("https://synthetic.invalid/resource", figure),
      ).rejects.toThrow();
      expect(downloadBlob).not.toHaveBeenCalled();
      if (size > 4) expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("surfaces authorization or missing-resource failures without downloading", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 403 })));
    await expect(
      downloadComputeNativeFigure("https://synthetic.invalid/resource", figure),
    ).rejects.toThrow("403");
    expect(downloadBlob).not.toHaveBeenCalled();
  });
});
