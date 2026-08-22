const MAX_COPY_DIMENSION = 8_192;
const MAX_COPY_PIXELS = 16_777_216;

export interface StaticImageCopyDimensions {
  readonly height: number;
  readonly width: number;
}

export function staticImageCopyDimensions(
  sourceWidth: number,
  sourceHeight: number,
): StaticImageCopyDimensions {
  if (
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    throw new Error("The image does not report usable dimensions.");
  }

  const scale = Math.min(
    1,
    MAX_COPY_DIMENSION / sourceWidth,
    MAX_COPY_DIMENSION / sourceHeight,
    Math.sqrt(MAX_COPY_PIXELS / (sourceWidth * sourceHeight)),
  );
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
  };
}

export async function fetchImageBlob(url: string): Promise<Blob> {
  // User actions must read fresh authorized bytes instead of reusing an
  // opaque response that may have been cached by a previous <img> request.
  const response = await fetch(url, { cache: "no-store", mode: "cors" });
  if (!response.ok) {
    throw new Error(`The image request failed with status ${response.status}.`);
  }
  const blob = await response.blob();
  if (!blob.type.toLowerCase().startsWith("image/")) {
    throw new Error("The file is not an image.");
  }
  return blob;
}

async function loadBlobImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      image.addEventListener("load", () => resolve(), { once: true });
      image.addEventListener(
        "error",
        () => reject(new Error("The browser could not decode the image.")),
        { once: true },
      );
      image.src = url;
    });
    return image;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function imageBlobToPng(blob: Blob): Promise<Blob> {
  const image = await loadBlobImage(blob);
  const dimensions = staticImageCopyDimensions(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = dimensions.width;
  canvas.height = dimensions.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("The browser could not create an image canvas.");
  context.drawImage(image, 0, 0, dimensions.width, dimensions.height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((png) => {
      if (png) resolve(png);
      else reject(new Error("The browser could not encode the image as PNG."));
    }, "image/png");
  });
}

export async function copyPngBlobToClipboard(png: Blob): Promise<void> {
  if (png.type.toLowerCase() !== "image/png") {
    throw new Error("Copy image requires an encoded PNG.");
  }

  const desktopCopy =
    typeof window === "undefined" ? undefined : window.desktopBridge?.copyPngToClipboard;
  if (desktopCopy != null) {
    await desktopCopy(new Uint8Array(await png.arrayBuffer()));
    return;
  }

  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write == null) {
    throw new Error("Copy image is unavailable in this environment.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}

export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  try {
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
  }
}

export async function copyStaticImage(url: string): Promise<void> {
  const source = await fetchImageBlob(url);
  const png = source.type.toLowerCase() === "image/png" ? source : await imageBlobToPng(source);
  await copyPngBlobToClipboard(png);
}

export async function downloadStaticImage(url: string, fileName: string): Promise<void> {
  downloadBlob(await fetchImageBlob(url), fileName);
}
