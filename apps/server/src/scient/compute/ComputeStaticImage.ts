import type { ComputeImageMediaType } from "@scientfactory/compute";

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_IHDR = new Uint8Array([0x49, 0x48, 0x44, 0x52]);

export interface ComputeStaticImageInspection {
  readonly width: number | null;
  readonly height: number | null;
}

function pngDimensions(bytes: Uint8Array): ComputeStaticImageInspection | null {
  if (bytes.byteLength < 24) return null;
  if (!PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return null;
  if (!PNG_IHDR.every((value, index) => bytes[12 + index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, false) !== 13) return null;
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0 ? { width, height } : null;
}

function hasSvgRoot(source: string): boolean {
  let remaining = source.replace(/^\uFEFF/u, "").trimStart();
  for (let index = 0; index < 16; index += 1) {
    if (/^<svg(?:\s|\/?>)/iu.test(remaining)) return true;
    if (remaining.startsWith("<?xml")) {
      const end = remaining.indexOf("?>");
      if (end < 0) return false;
      remaining = remaining.slice(end + 2).trimStart();
      continue;
    }
    if (remaining.startsWith("<!--")) {
      const end = remaining.indexOf("-->");
      if (end < 0) return false;
      remaining = remaining.slice(end + 3).trimStart();
      continue;
    }
    const doctype = /^<!DOCTYPE\s+svg\b[^>]*>/iu.exec(remaining);
    if (doctype === null) return false;
    remaining = remaining.slice(doctype[0].length).trimStart();
  }
  return false;
}

/** One validation policy for runtime displays and observed project figures. */
export function inspectComputeStaticImage(
  mediaType: ComputeImageMediaType,
  bytes: Uint8Array,
): ComputeStaticImageInspection | null {
  if (mediaType === "image/png") return pngDimensions(bytes);
  try {
    return hasSvgRoot(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      ? { width: null, height: null }
      : null;
  } catch {
    return null;
  }
}
