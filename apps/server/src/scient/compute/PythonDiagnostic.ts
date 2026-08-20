import type { ComputeDiagnostic, ComputeRuntimeErrorReport } from "@scientfactory/compute";

// ---------------------------------------------------------------------------
// Limits (from Phase 2 plan §2.10)
// ---------------------------------------------------------------------------

const MAX_TRACEBACK_LINES = 200;
const MAX_TRACEBACK_LINE_BYTES = 4096;
const MAX_ERROR_NAME_BYTES = 256;
const MAX_ERROR_VALUE_BYTES = 16384;

// ---------------------------------------------------------------------------
// ANSI / control sequence stripping
// ---------------------------------------------------------------------------

// Matches CSI sequences (the most common ANSI escape), single-char C1 controls,
// and OSC sequences.  Python tracebacks sometimes embed colour codes from
// IPython or rich; stripping them keeps the diagnostic readable and prevents
// control characters from reaching durable storage or the UI.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- ANSI escape codes are the input we are cleaning.
  /(?:\u001B\[[0-9;]*[a-zA-Z])|(?:\u001B\][^\u0007]*(?:\u0007|\u001B\\))|(?:[\u0000-\u0008\u000B\u000C\u000E-\u001F])/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

// ---------------------------------------------------------------------------
// Unicode-safe truncation
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function truncateOnByteBoundary(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  // Walk through complete UTF-8 characters and keep only those that fit
  // within the byte limit.  This avoids producing U+FFFD replacement
  // characters (3 bytes each) from incomplete multi-byte sequences.
  let safeEnd = 0;
  for (let i = 0; i < bytes.byteLength && i < maxBytes; ) {
    const byte = bytes[i]!;
    let charLen: number;
    if (byte < 0x80) charLen = 1;
    else if ((byte & 0xe0) === 0xc0) charLen = 2;
    else if ((byte & 0xf0) === 0xe0) charLen = 3;
    else charLen = 4;
    if (i + charLen <= maxBytes) {
      safeEnd = i + charLen;
    }
    i += charLen;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, safeEnd));
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/**
 * Normalizes a raw Python error report into one or more `ComputeDiagnostic`
 * records.
 *
 * Strips ANSI/control sequences, bounds every field, preserves the
 * human-readable traceback, and extracts no filesystem authority from
 * traceback strings.
 *
 * There are deliberately no structured frames. Turning `File "/x/y.py", line 3`
 * into something a client could click needs a project root to resolve it
 * against, and this function is handed a string from a runtime it does not
 * trust and has no project authority of its own -- inventing one here would put
 * path resolution in the one place that cannot check it. The verbatim traceback
 * is enough for a renderer to linkify against the workspace it already knows.
 */
export function normalizePythonDiagnostic(
  report: ComputeRuntimeErrorReport,
): ReadonlyArray<ComputeDiagnostic> {
  const errorName = truncateOnByteBoundary(stripAnsi(report.name), MAX_ERROR_NAME_BYTES);
  const message = truncateOnByteBoundary(stripAnsi(report.value), MAX_ERROR_VALUE_BYTES);

  // Emptied lines are dropped before the limit is applied, not after: a colour
  // reset on its own line is nothing a reader needs, and counting it would let
  // a traceback spend its whole allowance on lines that say nothing.
  const traceback = report.traceback
    .map(stripAnsi)
    .map((line) => truncateOnByteBoundary(line, MAX_TRACEBACK_LINE_BYTES))
    .filter((line) => line.length > 0)
    .slice(0, MAX_TRACEBACK_LINES);

  return [{ errorName, message, traceback }];
}
