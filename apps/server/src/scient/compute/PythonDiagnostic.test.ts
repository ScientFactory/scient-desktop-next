import { describe, expect, it } from "@effect/vitest";

import { normalizePythonDiagnostic } from "./PythonDiagnostic.ts";

describe("python diagnostic normalization", () => {
  it("preserves a clean traceback", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "ValueError",
      value: "invalid literal for int()",
      traceback: [
        '  File "<string>", line 1, in <module>',
        "    int('abc')",
        "ValueError: invalid literal for int()",
      ],
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.errorName).toBe("ValueError");
    expect(diagnostics[0]!.message).toBe("invalid literal for int()");
    expect(diagnostics[0]!.traceback).toEqual([
      '  File "<string>", line 1, in <module>',
      "    int('abc')",
      "ValueError: invalid literal for int()",
    ]);
  });

  it("strips ANSI colour codes from every field", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "\u001B[31mTypeError\u001B[0m",
      value: "\u001B[31munsupported operand\u001B[0m",
      traceback: ['\u001B[31m  File "x", line 1\u001B[0m', "\u001B[32m  x + 1\u001B[0m"],
    });
    expect(diagnostics[0]!.errorName).toBe("TypeError");
    expect(diagnostics[0]!.message).toBe("unsupported operand");
    expect(diagnostics[0]!.traceback).toEqual(['  File "x", line 1', "  x + 1"]);
  });

  it("strips OSC and other C1 control sequences", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "Error",
      value: "msg",
      traceback: ["\u0007normal\u0000text\u000B"],
    });
    expect(diagnostics[0]!.traceback).toEqual(["normaltext"]);
  });

  it("truncates error name to 256 bytes on a Unicode boundary", () => {
    const longName = "E" + "\u00e9".repeat(200); // each é is 2 bytes in UTF-8
    const diagnostics = normalizePythonDiagnostic({
      name: longName,
      value: "v",
      traceback: [],
    });
    const encoded = new TextEncoder().encode(diagnostics[0]!.errorName);
    expect(encoded.byteLength).toBeLessThanOrEqual(256);
  });

  it("truncates error value to 16 KiB on a Unicode boundary", () => {
    const longValue = "x".repeat(20_000);
    const diagnostics = normalizePythonDiagnostic({
      name: "E",
      value: longValue,
      traceback: [],
    });
    const encoded = new TextEncoder().encode(diagnostics[0]!.message);
    expect(encoded.byteLength).toBeLessThanOrEqual(16384);
  });

  it("limits traceback to 200 lines", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "E",
      value: "v",
      traceback: Array(250).fill("line"),
    });
    expect(diagnostics[0]!.traceback).toHaveLength(200);
  });

  it("truncates each traceback line to 4 KiB", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "E",
      value: "v",
      traceback: ["x".repeat(5000)],
    });
    const encoded = new TextEncoder().encode(diagnostics[0]!.traceback[0]!);
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
  });

  it("drops empty traceback lines after stripping", () => {
    const diagnostics = normalizePythonDiagnostic({
      name: "E",
      value: "v",
      traceback: ["real line", "\u001B[31m\u001B[0m", "   ", "another line"],
    });
    expect(diagnostics[0]!.traceback).toEqual(["real line", "   ", "another line"]);
  });

  it("spends the line limit on lines that say something", () => {
    // A traceback that opens with two hundred colour resets still has to show
    // the frames that follow them.
    const traceback = [...Array<string>(200).fill("\u001B[0m"), "real line", "another line"];
    const diagnostics = normalizePythonDiagnostic({ name: "E", value: "v", traceback });
    expect(diagnostics[0]!.traceback).toEqual(["real line", "another line"]);
  });

  it("truncates safely on a multi-byte character boundary", () => {
    // 🎉 is 4 bytes in UTF-8.  Truncating at 5 bytes must not produce a
    // replacement character or a broken string.
    const diagnostics = normalizePythonDiagnostic({
      name: "E",
      value: "v",
      traceback: ["🎉".repeat(2000)],
    });
    const line = diagnostics[0]!.traceback[0]!;
    const encoded = new TextEncoder().encode(line);
    expect(encoded.byteLength).toBeLessThanOrEqual(4096);
    // No U+FFFD replacement character from incomplete decoding.
    expect(line).not.toContain("\uFFFD");
  });
});
