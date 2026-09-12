import { downloadBlob } from "~/components/preview/staticImageActions";

import type { ComputeFigureNativeDownload } from "./computeFigurePresentation";
import {
  COMPUTE_NATIVE_FIGURE_MEDIA_TYPE,
  MAX_COMPUTE_NATIVE_FIGURE_BYTES,
} from "./computeResultPresentation";

/** Fetch only the retained, authorized resource; never evaluate the native file. */
export async function downloadComputeNativeFigure(
  url: string,
  figure: ComputeFigureNativeDownload,
): Promise<void> {
  if (
    !Number.isSafeInteger(figure.byteLength) ||
    figure.byteLength <= 0 ||
    figure.byteLength > MAX_COMPUTE_NATIVE_FIGURE_BYTES
  ) {
    throw new Error("The FIG file exceeds the download limit.");
  }
  const response = await fetch(url, {
    cache: "no-store",
    mode: "cors",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok || response.body === null) {
    await response.body?.cancel();
    throw new Error(`The FIG request failed with status ${response.status}.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let byteLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > figure.byteLength) {
        throw new Error("The FIG download exceeded its retained size.");
      }
      chunks.push(new Uint8Array(value));
    }
    if (byteLength !== figure.byteLength) throw new Error("The FIG download is incomplete.");
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  downloadBlob(new Blob(chunks, { type: COMPUTE_NATIVE_FIGURE_MEDIA_TYPE }), figure.fileName);
}
