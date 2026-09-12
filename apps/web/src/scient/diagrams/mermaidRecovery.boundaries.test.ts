import { describe, expect, it } from "vite-plus/test";
import { planMermaidRecovery } from "./mermaidRecovery";
import { recoveryFixtures } from "./mermaidRecovery.fixtures";

describe("Mermaid recovery ambiguity and preservation boundaries", () => {
  it("bounds adversarial scanning without pathological whitespace or suffix backtracking", () => {
    const long = " ".repeat(40_000);
    const inputs = [
      "pie\nDogs" + long + "invalid",
      "pie\nDogs:" + long + "invalid",
      "pie\n" + long + "invalid",
      "flowchart LR\nA[" + "(x)".repeat(12_000) + "]",
      'flowchart LR\nA["' + "x\\\\".repeat(12_000),
      "classDiagram\nclass A {\n" + "x".repeat(40_000),
      "quadrantChart\nA" + long + "invalid",
      "quadrantChart\nx-axis A" + long + "invalid",
      "sequenceDiagram\nparticipant A\nparticipant B\nA->>B" + long + ": invalid",
      "gitGraph\nbranchz" + long + "invalid extra",
    ];
    const start = performance.now();
    const elapsed = inputs.map(() => 0);
    for (let round = 0; round < 20; round += 1) {
      for (const [index, source] of inputs.entries()) {
        const before = performance.now();
        expect(() => planMermaidRecovery(source)).not.toThrow();
        elapsed[index]! += performance.now() - before;
      }
    }
    expect(performance.now() - start, JSON.stringify(elapsed)).toBeLessThan(3_000);
  });
  it.each([
    "flowchart LR\nA[Start --> B",
    'flowchart LR\nA["Start" ] ->> B',
    'flowchart LR\nA(("Start" --> B',
    'flowchart LR\nA[["Start" --> B',
    'flowchart LR\nA["Start" --> B[Still unclosed',
    'flowchart LR\nA["a "b" -> c"] --> D',
    'flowchart LR\nA["`Click \\"Save\\"`"] --> B',
    'flowchart LR\nA["<b>Click \\"Save\\"</b>"] --> B',
    'flowchart LR\nA["$$x \\"q\\"$$"] --> B',
    'flowchart LR\nA["Path C:\\\\temp"] --> B',
    'flowchart LR\nA["odd "quote"] --> B',
    "flowchart LR\nA[Value [unknown]]",
    "flowchart SIDEWAYS\nA -> B",
    "flawchart LR\nA -> B",
    "sequenceDiagram\nparticipant A\nparticipant B\nA->>>B: Request",
    "sequenceDiagram\nparticipant A\nparticipant B\nNote over A,C Hello",
    "sequenceDiagram\nparticipant A\nparticipant B\nA->>B C: Recipient with spaces",
    "sequenceDiagram\nparticipant A\nparticipant B\nNote right of A C: Multiword recipient",
    "sequenceDiagram\nparticipant A\nparticipant B\nA->>B: hello; B->>A No separator inside message",
    "pie\nDogs 10",
    "pie\nDogs: -10",
    "pie\nDogs: 1,5",
    "pie\nDogs: 1e3",
    "pie\nDogs: NaN",
    'pie title Pet Ownership\n"Dogs" -- 40',
    'pie title Pet Ownership\n"Dogs" - -40',
    "pie title Pet Ownership\nDogs - 40",
    "stateDiagram-v2\nSuccess -->",
    "stateDiagram-v2\nnote right of Idle\nA -> B\nend note",
    "classDiagram\nclass A {\nB -> C\n}",
    "classDiagram\nclass A {\nB -> C\n",
    'stateDiagram-v2\nstate "Container" as Outer {\nA -> B\n}',
    "stateDiagram-v2\nIdle : description -> unchanged",
    "classDiagram\nA : method() -> B",
    'gitGraph\ncommit id: "branchz feature"\nbranch branchz\ncheckout branchz',
    "gitGraph\nbranchzz feature",
    "gitGraph\nbranchz",
    'gitGraph\ncommit id: "multiline\nbranchz feature\n"',
    "erDiagram\nCUSTOMER ||--o{ ORDER : places\nORDER }-- LINE_ITEM : contains",
    "quadrantChart\nTask A: (.3, 0.6)",
    "quadrantChart\nTask A: (0.3, 2)",
    "quadrantChart\nTask A: (0.3, 0.6]",
    "C4Context\nPersons",
    'C4Context\nPerson(customer, "Customer")',
    'C4Context\ntitle Persons(customer, "Customer")',
  ])("does not invent or rewrite meaning: %s", (source) => {
    expect(planMermaidRecovery(source)).toBeNull();
  });

  it("keeps unrelated syntax opaque while repairing a different statement", () => {
    const cases = [
      [
        "flowchart LR\n",
        "A -> B",
        "A --> B",
        [
          'X["First\nSecond"]',
          'X@{\nshape: rect\nlabel: "A -> B"\n}',
          "accDescr {\nA -> B\n}",
          "%% A -> B; C -> D",
          "style X fill:#fff %% A -> B",
          'X["semicolon; A -> B"]',
          'X["`A -> B`"]',
          'click X "https://example.test/?q=A->B"',
        ],
      ],
      [
        "sequenceDiagram\nparticipant A\nparticipant B\n",
        "A->>B Hello",
        "A->>B: Hello",
        [
          "Note over A,B: Ignore; A->>B Hello",
          "A->>B: Keep -> and ： and ; Note over A,B hello",
          "accDescr {\nA->>B Hello\n}",
          "%% A->>B Hello",
        ],
      ],
      [
        "classDiagram\n",
        "A -> B",
        "A --> B",
        [
          "class Example {\nInner -> Other\n}",
          "class Example { Inner -> Other }",
          'note for Example "Inner -> Other"',
          "accDescr {\nInner -> Other\n}",
        ],
      ],
      [
        "stateDiagram-v2\n",
        "Idle -> Busy",
        "Idle --> Busy",
        [
          'state "Compound" as Compound {\nA -> B\n}',
          "note right of Idle\nA -> B\nend note",
          "accDescr {\nIdle -> Busy\n}",
        ],
      ],
      [
        "gitGraph\n",
        "branchz feature",
        "branch feature",
        [
          'commit id: "branchz unrelated"',
          "%% branchz unrelated",
          "branch branchz\ncheckout branchz",
          "accDescr {\nbranchz unrelated\n}",
        ],
      ],
    ] as const;
    for (const [header, broken, corrected, regions] of cases) {
      for (const region of regions) {
        for (const newline of ["\n", "\r\n", "\r"]) {
          const original = (header + region + "\n" + broken).replaceAll("\n", newline);
          const expected = (header + region + "\n" + corrected).replaceAll("\n", newline);
          expect(planMermaidRecovery(original)?.source, original).toBe(expected);
        }
      }
    }
  });

  it("keeps all original UTF-16 spans exact across every family, Unicode and line ending", () => {
    for (const fixture of recoveryFixtures) {
      for (const newline of ["\n", "\r\n", "\r"]) {
        // Prefix is a comment, not a rewritten label or command identifier.
        const prefix = "%% 🧪 שלום 读取\n";
        const source = (prefix + fixture.source.replaceAll("\r\n", "\n")).replaceAll("\n", newline);
        // Frontmatter must stay the first line; it cannot follow a comment.
        if (fixture.source.startsWith("---")) continue;
        const expected = (prefix + fixture.expected.replaceAll("\r\n", "\n")).replaceAll(
          "\n",
          newline,
        );
        const plan = planMermaidRecovery(source);
        expect(plan?.source, fixture.name).toBe(expected);
        expect(plan?.originalSource).toBe(source);
        expect(planMermaidRecovery(expected)).toBeNull();
      }
    }
  });

  it("does not treat free-text semicolons as new commands", () => {
    const source =
      "sequenceDiagram\nparticipant A\nparticipant B\nNote over A,B: keep; A->>B Hello\nA->>B Fix";
    expect(planMermaidRecovery(source)?.source).toBe(source.replace("B Fix", "B: Fix"));
    for (const prefix of ["accTitle: ", "accDescr: "]) {
      const metadata = "flowchart LR\n" + prefix + 'literal; A -> B; keep unmatched " [ {\nC -> D';
      expect(planMermaidRecovery(metadata)?.source).toBe(metadata.replace("C -> D", "C --> D"));
    }
    const state = "stateDiagram-v2\nIdle : text; A -> B\nIdle -> Busy";
    expect(planMermaidRecovery(state)?.source).toBe(state.replace("Idle -> Busy", "Idle --> Busy"));
    const flow = "flowchart LR\nX -->|keep; A -> B; text| Y\nC -> D";
    expect(planMermaidRecovery(flow)?.source).toBe(flow.replace("C -> D", "C --> D"));
    const quotedPipe = 'flowchart LR\nX -->|"a | b; A -> B"| Y\nC -> D';
    expect(planMermaidRecovery(quotedPipe)?.source).toBe(quotedPipe.replace("C -> D", "C --> D"));
  });

  it("handles many bounded edits atomically, without leaking partial repairs beyond the cap", () => {
    for (let count = 1; count <= 256; count += 17) {
      const source =
        "Flowchart lr; " +
        Array.from({ length: count }, (_, i) => `N${i}[Read (local)] -> N${i + 1}`).join(";");
      const plan = planMermaidRecovery(source);
      if (2 + count * 2 > 256) expect(plan).toBeNull();
      else {
        expect(plan?.edits).toHaveLength(2 + count * 2);
        expect(plan?.source).toBe(
          "flowchart LR; " +
            Array.from({ length: count }, (_, i) => `N${i}["Read (local)"] --> N${i + 1}`).join(
              ";",
            ),
        );
        expect(planMermaidRecovery(plan!.source)).toBeNull();
      }
    }
  });
});
