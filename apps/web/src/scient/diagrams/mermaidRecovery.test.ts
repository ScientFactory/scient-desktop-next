import { describe, expect, it } from "vite-plus/test";
import { isMermaidSyntaxError, planMermaidRecovery } from "./mermaidRecovery";
import { recoveryFixtures } from "./mermaidRecovery.fixtures";

describe("atomic Mermaid recovery plans", () => {
  it.each([
    "Parse error on line 3:",
    "Lexical error on line 2:",
    "Parsing failed: Lexer error on line 3, column 7:",
    "Parsing failed:  Parse error on line 2, column 8:",
    "No diagram type detected matching given configuration",
  ])("recognizes native syntax diagnostics: %s", (message) => {
    expect(isMermaidSyntaxError(new Error(message))).toBe(true);
  });
  it.each(recoveryFixtures)("$name", ({ source, expected }) => {
    const result = planMermaidRecovery(source);
    expect(result?.source).toBe(expected);
    expect(result?.originalSource).toBe(source);
    let cursor = 0;
    let reconstructed = "";
    for (const change of result!.edits) {
      expect(change.start).toBeGreaterThanOrEqual(cursor);
      expect(source.slice(change.start, change.end)).toBe(change.original);
      reconstructed += source.slice(cursor, change.start) + change.replacement;
      cursor = change.end;
    }
    expect(reconstructed + source.slice(cursor)).toBe(expected);
    expect(planMermaidRecovery(expected)).toBeNull();
  });

  it.each([
    "flowchart LR\nA(Start]",
    "flowchart LR\nA[One [nested] label]",
    "flowchart LR\nA[Start",
    "flowchart LR\nA --> B[End]",
    'flowchart LR\nA["`Markdown (label)`"] --> B',
    'flowchart LR\nA["$$x^2$$"] --> B',
    'flowchart LR\nA@{ shape: rect, label: "Read (local)" } --> B',
    'flowchart LR\nA["<b>Read (local)</b>"] --> B',
    "flowchart LR\nA ----> B", // longer legal edges are not short-link typos
    "flowchart LR\nA -->|Use -> operator| B",
    "flowchart LR\n%% A -> B\nA --> B",
    'flowchart LR\nclick A "https://host/?q=->"\nA --> B',
    "sequenceDiagram\nA->>B Hello",
    "sequenceDiagram\nparticipant A\nparticipant B\nA->>B : Hello",
    'pie\n"Dogs -> Cats" : 10',
    'pie\n"Dogs" 1,5',
    "accTitle: First\naccTitle: Last\nflowchart LR\nA -> B",
    "accTitle: First\nflowchart LR\naccTitle: Last\nA -> B",
    "---\nflowchart LR\nA -> B",
    'flowchart LR\nA["multiline\nB -> C\n"]',
    "flowchart LR\naccDescr {\nA -> B\n}\nA --> B",
    "flowchart LR\n%%{init: {\nA -> B\n}}%%",
  ])("declines ambiguous or already supported source: %s", (source) => {
    expect(planMermaidRecovery(source)).toBeNull();
  });

  it("combines independent rules in original-source offsets, including CRLF", () => {
    const fixture = recoveryFixtures.find((entry) => entry.name === "multiple independent issues")!;
    const result = planMermaidRecovery(fixture.source.replaceAll("\n", "\r\n"))!;
    expect(result.source).toBe(fixture.expected.replaceAll("\n", "\r\n"));
    expect(new Set(result.edits.map((change) => change.rule))).toEqual(
      new Set(["metadata", "label", "link"]),
    );
  });

  it("does not reinterpret a multiword sequence recipient while fixing another message", () => {
    const source =
      "sequenceDiagram\nparticipant A\nparticipant B\nA->>B C: Keep this recipient\nA->>B Hello";
    expect(planMermaidRecovery(source)?.source).toBe(source.replace("B Hello", "B: Hello"));
    expect(planMermaidRecovery('pie\n"multiline\n"Dogs" 10\n"')).toBeNull();
  });
  it("retains CR metadata separators and does not relocate a leading BOM", () => {
    expect(planMermaidRecovery("accTitle: Example\rflowchart LR")?.source).toBe(
      "flowchart LR\raccTitle: Example\r",
    );
    expect(planMermaidRecovery("\uFEFFaccTitle: Example\nflowchart LR\nA -> B")).toBeNull();
  });

  it("preserves protected regions across 2,000 deterministic combinations", () => {
    const labels = [
      '"C4Context"',
      '"`Read (local)`"',
      '"$$x^2$$"',
      '"<b>Read (local)</b>"',
      "Use -> operator",
      '"שלום（עולם） 🧪"',
      '"读取 → 文件"',
      '"#quot;literal#quot;"',
    ];
    for (let index = 0; index < 2_000; index += 1) {
      const newline = index % 2 ? "\r\n" : "\n";
      const label = labels[index % labels.length]!;
      const prefix = `---${newline}title: 'A -> B (${index})'${newline}---${newline}flowchart LR${newline}%% A -> B (${index})${newline}`;
      const statement = `A[${label}] -> B[Read (local)]`;
      const suffix = `${newline}classDef data color:#333333,fill:#eeeeee${newline}`;
      const source = prefix + statement + suffix;
      const result = planMermaidRecovery(source)!;
      expect(result.source).toBe(prefix + `A[${label}] --> B["Read (local)"]` + suffix);
      expect(result.edits).toHaveLength(2);
    }
  });

  it("bounds large input and edit counts without truncating a candidate", () => {
    expect(planMermaidRecovery("flowchart LR\n" + "A -> B\n".repeat(257))).toBeNull();
    expect(planMermaidRecovery("x".repeat(50_001))).toBeNull();
    const nearLimit = "flowchart LR\nA -> B\n%% " + "x".repeat(49_976);
    expect(nearLimit.length).toBe(49_999);
    expect(planMermaidRecovery(nearLimit)?.source.length).toBe(50_000);
    expect(planMermaidRecovery(nearLimit + "x")).toBeNull();
  });

  it.each([
    "Failed to fetch dynamically imported module",
    "Maximum number of edges exceeded",
    "Mermaid returned an invalid diagram.",
    "DOMPurify unavailable",
    "Layout failed",
    "Security exception",
  ])("does not recover infrastructure failure: %s", (message) => {
    expect(isMermaidSyntaxError(new Error(message))).toBe(false);
  });
});
