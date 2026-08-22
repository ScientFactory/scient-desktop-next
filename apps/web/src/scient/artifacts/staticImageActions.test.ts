import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  copyStaticImage,
  downloadStaticImage,
  staticImageCopyDimensions,
} from "./staticImageActions";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static image copy dimensions", () => {
  it("preserves ordinary image dimensions", () => {
    expect(staticImageCopyDimensions(1_200, 800)).toEqual({ width: 1_200, height: 800 });
  });

  it("bounds extremely large images by dimension and pixel count", () => {
    const wide = staticImageCopyDimensions(20_000, 2_000);
    expect(wide.width).toBe(8_192);
    expect(wide.height).toBe(819);

    const square = staticImageCopyDimensions(10_000, 10_000);
    expect(square.width * square.height).toBeLessThanOrEqual(16_777_216);
    expect(square.width).toBe(square.height);
  });

  it("rejects absent and invalid intrinsic dimensions", () => {
    expect(() => staticImageCopyDimensions(0, 100)).toThrow(/usable dimensions/u);
    expect(() => staticImageCopyDimensions(Number.NaN, 100)).toThrow(/usable dimensions/u);
  });
});

describe("static image byte actions", () => {
  it("copies an existing PNG without re-encoding it", async () => {
    const source = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
    const write = vi.fn().mockResolvedValue(undefined);
    const items: Array<Record<string, Blob>> = [];
    function TestClipboardItem(data: Record<string, Blob>) {
      items.push(data);
    }
    const fetch = vi.fn().mockResolvedValue({ ok: true, blob: async () => source });
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);

    await copyStaticImage("https://environment.test/figure.png");

    expect(items).toEqual([{ "image/png": source }]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("https://environment.test/figure.png", {
      cache: "no-store",
      mode: "cors",
    });
  });

  it("decodes and rasterizes SVG before copying PNG clipboard bytes", async () => {
    const source = new Blob(["<svg/>"], { type: "image/svg+xml" });
    const png = new Blob([new Uint8Array([8, 9, 10])], { type: "image/png" });
    const drawImage = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const items: Array<Record<string, Blob>> = [];
    let loadListener: (() => void) | undefined;

    class TestImage {
      decoding = "auto";
      naturalHeight = 400;
      naturalWidth = 600;
      addEventListener(type: string, listener: () => void) {
        if (type === "load") loadListener = listener;
      }
      set src(_value: string) {
        loadListener?.();
      }
    }
    function TestClipboardItem(data: Record<string, Blob>) {
      items.push(data);
    }

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => source }));
    vi.stubGlobal("Image", TestImage);
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:test-image",
      revokeObjectURL: vi.fn(),
    });
    vi.stubGlobal("document", {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ drawImage }),
        toBlob: (callback: (value: Blob) => void) => callback(png),
      }),
    });
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal("ClipboardItem", TestClipboardItem);

    await copyStaticImage("https://environment.test/figure.svg");

    expect(drawImage).toHaveBeenCalledWith(expect.any(TestImage), 0, 0, 600, 400);
    expect(items).toEqual([{ "image/png": png }]);
    expect(write).toHaveBeenCalledOnce();
  });

  it("downloads the unmodified original bytes with the artifact filename", async () => {
    const source = new Blob(["<svg/>"], { type: "image/svg+xml" });
    const click = vi.fn();
    const remove = vi.fn();
    const append = vi.fn();
    const revokeObjectURL = vi.fn();
    const anchor = {
      download: "",
      href: "",
      rel: "",
      style: { display: "" },
      click,
      remove,
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => source }));
    vi.stubGlobal("URL", {
      createObjectURL: () => "blob:download",
      revokeObjectURL,
    });
    vi.stubGlobal("document", {
      body: { append },
      createElement: () => anchor,
    });
    vi.stubGlobal("window", {
      setTimeout: (callback: () => void) => {
        callback();
        return 1;
      },
    });

    await downloadStaticImage("https://environment.test/figure.svg", "figure.svg");

    expect(anchor.href).toBe("blob:download");
    expect(anchor.download).toBe("figure.svg");
    expect(anchor.rel).toBe("noopener");
    expect(append).toHaveBeenCalledWith(anchor);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:download");
  });

  it("rejects failed requests and non-image responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    await expect(
      downloadStaticImage("https://environment.test/missing.png", "missing.png"),
    ).rejects.toThrow(/status 404/u);

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        blob: async () => new Blob(["not an image"], { type: "text/plain" }),
      }),
    );
    await expect(
      downloadStaticImage("https://environment.test/file.txt", "file.txt"),
    ).rejects.toThrow(/not an image/u);
  });
});
