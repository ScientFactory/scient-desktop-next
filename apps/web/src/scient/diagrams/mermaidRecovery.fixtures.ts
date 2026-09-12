/** Shared pure-rule and real-renderer regression corpus. Not imported by product code. */
// User-reported regression corpus: retain the four ambiguous errors, repair the
// command-position typo, and leave the five already valid diagrams untouched.
export const userRegressionFixtures = [
  {
    name: "1 valid flowchart",
    source:
      "flowchart TD\n    A[Start] --> B{Is it raining?}\n    B -->|Yes| C[Take umbrella]\n    B -->|No| D[Go outside]\n    C --> D\n    D --> E[End]",
    status: "native",
  },
  {
    name: "2 unclosed bracket",
    source:
      "flowchart TD\n    A[Start --> B{Is it raining?}\n    B -->|Yes| C[Take umbrella]\n    B -->|No| D[Go outside]\n    C --> D\n    D --> E[End]",
    status: "error",
  },
  {
    name: "3 valid sequence",
    source:
      "sequenceDiagram\n    participant U as User\n    participant F as Frontend\n    participant A as Auth Service\n    participant D as Database\n\n    U->>F: Enter credentials\n    F->>A: POST /login\n    A->>D: Query user by email\n    D-->>A: User record\n    alt valid password\n        A-->>F: 200 OK + token\n        F-->>U: Redirect to dashboard\n    else invalid password\n        A-->>F: 401 Unauthorized\n        F-->>U: Show error message\n    end\n    Note over A,D: Passwords are hashed with bcrypt",
    status: "native",
  },
  {
    name: "4 arrow and missing end",
    source:
      "sequenceDiagram\n    participant U as User\n    participant A as API\n    U->>>A: Request data\n    alt success\n        A-->>U: Return payload\n    else failure\n        A-->>U: Return error",
    status: "error",
  },
  {
    name: "5 valid class",
    source:
      'classDiagram\n    class Animal {\n        +String name\n        +int age\n        +makeSound()\n    }\n    class Dog {\n        +fetch()\n    }\n    class Cat {\n        +scratch()\n    }\n    class Trainer {\n        +List~Animal~ animals\n        +train(Animal a)\n    }\n    class Sound {\n        <<interface>>\n        +play()\n    }\n\n    Animal <|-- Dog\n    Animal <|-- Cat\n    Trainer o-- Animal : trains\n    Animal ..|> Sound\n    Dog --> "1" Bone : chews\n\n    class Bone {\n        +String material\n    }',
    status: "native",
  },
  {
    name: "6 missing state",
    source:
      "stateDiagram-v2\n    [*] --> Idle\n    Idle --> Loading: fetchData\n    Loading --> Success: onSuccess\n    Loading --> Error: onError\n    Error --> Loading: retry\n    Success -->\n    Success --> [*]",
    status: "error",
  },
  {
    name: "7 valid gantt",
    source:
      "gantt\n    title Project Rollout\n    dateFormat YYYY-MM-DD\n    section Design\n    Wireframes        :a1, 2026-09-10, 3d\n    Review            :after a1, 2d\n    section Build\n    Backend API       :b1, 2026-09-15, 5d\n    Frontend UI       :b2, after a1, 6d\n    section Launch\n    QA Testing        :2026-09-25, 3d\n    Go Live           :milestone, 2026-09-28, 0d",
    status: "native",
  },
  {
    name: "8 invalid cardinality",
    source:
      'erDiagram\n    CUSTOMER ||--o{ ORDER : places\n    ORDER }-- LINE_ITEM : contains\n    PRODUCT ||--|{ LINE_ITEM : "ordered in"',
    status: "error",
  },
  {
    name: "9 valid mindmap",
    source:
      "mindmap\n  root((Project))\n    Design\n      Wireframes\n      Style Guide\n    Build\n      API\n      UI\n    Launch\n      QA\n      Marketing",
    status: "native",
  },
  {
    name: "10 command typo",
    source:
      'gitGraph\n    commit id: "init"\n    branchz feature\n    checkout feature\n    commit id: "add feature"\n    checkout main\n    merge feature',
    status: "recovered",
  },
] as const;

export const recoveryFixtures = [
  {
    name: "two Git command typos",
    source: "gitGraph\ncommit\nbrach feature\nchekout feature\ncommit",
    expected: "gitGraph\ncommit\nbranch feature\ncheckout feature\ncommit",
  },
  {
    name: "quadrant title and quadrant labels",
    source:
      "quadrantChart\n title Priority (map)\n x-axis Cheap (cost) --> Expensive (cost)\n y-axis Small (impact) --> Large (impact)\n quadrant-1 Start (here)\n Team (A): [0.25, 0.75]",
    expected:
      'quadrantChart\n title "Priority (map)"\n x-axis "Cheap (cost)" --> "Expensive (cost)"\n y-axis "Small (impact)" --> "Large (impact)"\n quadrant-1 "Start (here)"\n "Team (A)": [0.25, 0.75]',
  },
  {
    name: "unquoted literal quotes",
    source: 'flowchart LR\nA[Calls logger.debug("message", data)] --> B',
    expected: 'flowchart LR\nA["Calls logger.debug(#quot;message#quot;, data)"] --> B',
  },
  {
    name: "pipe label content stays literal",
    source: "flowchart LR\nX -->|keep; A -> B; text| Y\nC -> D",
    expected: "flowchart LR\nX -->|keep; A -> B; text| Y\nC --> D",
  },
  {
    name: "header comment",
    source: "flowchart LR %% example\nA[Read (local)] --> B",
    expected: 'flowchart LR\n%% example\nA["Read (local)"] --> B',
  },
  {
    name: "header semicolon",
    source: "flowchart LR; A[Read (local)] --> B",
    expected: 'flowchart LR; A["Read (local)"] --> B',
  },
  {
    name: "unrelated multiline label",
    source: 'flowchart LR\nX["First\nSecond"]\nA[Read (local)] --> B',
    expected: 'flowchart LR\nX["First\nSecond"]\nA["Read (local)"] --> B',
  },
  {
    name: "modern multiline node",
    source: 'flowchart LR\nX@{\nshape: rect\nlabel: "Fine"\n}\nA[Read (local)] --> B',
    expected: 'flowchart LR\nX@{\nshape: rect\nlabel: "Fine"\n}\nA["Read (local)"] --> B',
  },
  {
    name: "parallel node expression",
    source: "flowchart LR\nA[Read (local)] & B --> C",
    expected: 'flowchart LR\nA["Read (local)"] & B --> C',
  },
  {
    name: "edge ID expression",
    source: "flowchart LR\nA[Read (local)] e1@--> B",
    expected: 'flowchart LR\nA["Read (local)"] e1@--> B',
  },
  {
    name: "header case flowchart",
    source: "Flowchart TD\nA --> B",
    expected: "flowchart TD\nA --> B",
  },
  {
    name: "header case sequence",
    source: "sequencediagram\nA->>B: Hello",
    expected: "sequenceDiagram\nA->>B: Hello",
  },
  { name: "direction case", source: "flowchart lr\nA --> B", expected: "flowchart LR\nA --> B" },
  {
    name: "sequence fullwidth colon",
    source: "sequenceDiagram\nparticipant A\nparticipant B\nA->>B：Hello",
    expected: "sequenceDiagram\nparticipant A\nparticipant B\nA->>B:Hello",
  },
  {
    name: "sequence note missing separator",
    source: "sequenceDiagram\nparticipant A\nparticipant B\nNote over A,B Cache warm",
    expected: "sequenceDiagram\nparticipant A\nparticipant B\nNote over A,B: Cache warm",
  },
  {
    name: "sequence note fullwidth colon",
    source: "sequenceDiagram\nparticipant A\nNote left of A ： Cache warm",
    expected: "sequenceDiagram\nparticipant A\nNote left of A : Cache warm",
  },
  {
    name: "state short arrow",
    source: "stateDiagram-v2\nIdle -> Loading: fetch",
    expected: "stateDiagram-v2\nIdle --> Loading: fetch",
  },
  { name: "class short arrow", source: "classDiagram\nA -> B", expected: "classDiagram\nA --> B" },
  {
    name: "pie unquoted label",
    source: "pie\nDogs: 10\nCats: 20",
    expected: 'pie\n"Dogs": 10\n"Cats": 20',
  },
  {
    name: "pie spaced label",
    source: "pie\nSmall dogs: 10\nBig cats: 20",
    expected: 'pie\n"Small dogs": 10\n"Big cats": 20',
  },
  {
    name: "pie dash separator",
    source: 'pie title Pet Ownership\n    "Dogs" - 40\n    "Cats" - 35\n    "Birds" - 25',
    expected: 'pie title Pet Ownership\n    "Dogs": 40\n    "Cats": 35\n    "Birds": 25',
  },
  {
    name: "xy title",
    source: "xychart-beta\n title Revenue (USD)\n x-axis [Jan, Feb]\n bar [10, 20]",
    expected: 'xychart-beta\n title "Revenue (USD)"\n x-axis [Jan, Feb]\n bar [10, 20]',
  },
  {
    name: "quadrant punctuation",
    source: "quadrantChart\n x-axis Low (cost) --> High (cost)\n Team (A): [0.2, 0.8]",
    expected: 'quadrantChart\n x-axis "Low (cost)" --> "High (cost)"\n "Team (A)": [0.2, 0.8]',
  },
  {
    name: "quadrant coordinate parentheses",
    source:
      "quadrantChart\n    title Reach vs Effort\n    x-axis Low Effort --> High Effort\n    y-axis Low Reach --> High Reach\n    quadrant-1 Do First\n    quadrant-2 Schedule\n    quadrant-3 Delegate\n    quadrant-4 Eliminate\n    Task A: (0.3, 0.6)\n    Task B: (0.8, 0.9)",
    expected:
      'quadrantChart\n    title "Reach vs Effort"\n    x-axis "Low Effort" --> "High Effort"\n    y-axis "Low Reach" --> "High Reach"\n    quadrant-1 "Do First"\n    quadrant-2 "Schedule"\n    quadrant-3 "Delegate"\n    quadrant-4 "Eliminate"\n    "Task A": [0.3, 0.6]\n    "Task B": [0.8, 0.9]',
  },
  {
    name: "C4 command typo",
    source:
      'C4Context\n    title System Context\n    Persons(customer, "Customer", "A user of the system")\n    System(system, "Our System", "Does the thing")\n    Rel(customer, system, "Uses")',
    expected:
      'C4Context\n    title System Context\n    Person(customer, "Customer", "A user of the system")\n    System(system, "Our System", "Does the thing")\n    Rel(customer, system, "Uses")',
  },
  {
    name: "subgraph ID and quoted title",
    source: 'flowchart LR\nsubgraph S "Backend (API)"\nA --> B\nend',
    expected: 'flowchart LR\nsubgraph S ["Backend (API)"]\nA --> B\nend',
  },
  {
    name: "nested literal quotes",
    source: 'flowchart LR\nA["Click "Save" now"] --> B',
    expected: 'flowchart LR\nA["Click #quot;Save#quot; now"] --> B',
  },
  {
    name: "escaped literal quotes",
    source: 'flowchart LR\nA["Click \\"Save\\" now"] --> B',
    expected: 'flowchart LR\nA["Click #quot;Save#quot; now"] --> B',
  },
  {
    name: "git command typo",
    source: "gitGraph\ncommit\nbranchz feature\ncheckout feature\ncommit",
    expected: "gitGraph\ncommit\nbranch feature\ncheckout feature\ncommit",
  },
  {
    name: "round nested parentheses",
    source: "flowchart LR\nA(Read (local)) --> B",
    expected: 'flowchart LR\nA("Read (local)") --> B',
  },
  {
    name: "circle nested parentheses",
    source: "flowchart LR\nA((Read (local))) --> B",
    expected: 'flowchart LR\nA(("Read (local)")) --> B',
  },
  {
    name: "explicit quoted square closure",
    source: 'flowchart LR\nA["Start" --> B',
    expected: 'flowchart LR\nA["Start"] --> B',
  },
  {
    name: "metadata before class",
    source: "accTitle: Animals\nclassDiagram\nAnimal <|-- Dog",
    expected: "classDiagram\naccTitle: Animals\nAnimal <|-- Dog",
  },
  {
    name: "metadata before state",
    source: "accTitle: Job\nstateDiagram-v2\nIdle --> Busy",
    expected: "stateDiagram-v2\naccTitle: Job\nIdle --> Busy",
  },
  {
    name: "metadata inline header and multiple repairs",
    source: 'accTitle: Pipeline\nFlowchart lr; A["Start" -> B[Read (local)]',
    expected: 'flowchart LR;\naccTitle: Pipeline\n A["Start"] --> B["Read (local)"]',
  },
  {
    name: "comments retain boundaries",
    source: "pie\nDogs: 10 %% Cats: 20\nCats：20",
    expected: 'pie\n"Dogs": 10 %% Cats: 20\n"Cats":20',
  },
  {
    name: "class body protected",
    source: "classDiagram\nclass Example {\n +String name\n}\nExample -> Result",
    expected: "classDiagram\nclass Example {\n +String name\n}\nExample --> Result",
  },
  {
    name: "state body protected",
    source: 'stateDiagram-v2\nstate "Active phase" as Active {\n[*] --> Ready\n}\nIdle -> Active',
    expected:
      'stateDiagram-v2\nstate "Active phase" as Active {\n[*] --> Ready\n}\nIdle --> Active',
  },
  {
    name: "rounded label and link",
    source: "flowchart LR\nA(Read {local}) -> B",
    expected: 'flowchart LR\nA("Read {local}") --> B',
    shape: "round",
    label: "Read {local}",
  },
  {
    name: "circle label and link",
    source: "flowchart LR\nA((Read {local})) -> B",
    expected: 'flowchart LR\nA(("Read {local}")) --> B',
    shape: "circle",
    label: "Read {local}",
  },
  {
    name: "cylinder label and link",
    source: "flowchart LR\nA[(Read {local})] -> B",
    expected: 'flowchart LR\nA[("Read {local}")] --> B',
    shape: "cylinder",
    label: "Read {local}",
  },
  {
    name: "hexagon label and link",
    source: "flowchart LR\nA{{Read (local)}} -> B",
    expected: 'flowchart LR\nA{{"Read (local)"}} --> B',
    shape: "hexagon",
    label: "Read (local)",
  },
  {
    name: "rectangle label",
    source: "flowchart LR\nA[Read file (local)] --> B",
    expected: 'flowchart LR\nA["Read file (local)"] --> B',
  },
  {
    name: "diamond label",
    source: "flowchart TD\nA{Ready (now)?} --> B",
    expected: 'flowchart TD\nA{"Ready (now)?"} --> B',
  },
  {
    name: "stadium label",
    source: "flowchart LR\nA([Read (local)]) --> B",
    expected: 'flowchart LR\nA(["Read (local)"]) --> B',
  },
  {
    name: "subroutine label",
    source: "flowchart LR\nA[[Read (local)]] --> B",
    expected: 'flowchart LR\nA[["Read (local)"]] --> B',
  },
  {
    name: "edge label",
    source: "flowchart LR\nA -->|GET /api/{id}| B",
    expected: 'flowchart LR\nA -->|"GET /api/{id}"| B',
  },
  {
    name: "explicit subgraph",
    source: "flowchart LR\nsubgraph S[Group (one)]\nA --> B\nend",
    expected: 'flowchart LR\nsubgraph S["Group (one)"]\nA --> B\nend',
  },
  { name: "short link", source: "flowchart LR\nA->B", expected: "flowchart LR\nA-->B" },
  {
    name: "literal operator",
    source: "flowchart LR\nA[Use -> operator] -> B",
    expected: "flowchart LR\nA[Use -> operator] --> B",
  },
  { name: "dotted link", source: "flowchart LR\nA -. --> B", expected: "flowchart LR\nA -.-> B" },
  {
    name: "multiple independent issues",
    source:
      "accTitle: Local data\naccDescr: Read and process data\nflowchart LR\nA[Read (local)] -> B[Process (safe)]\nB -. --> C",
    expected:
      'flowchart LR\naccTitle: Local data\naccDescr: Read and process data\nA["Read (local)"] --> B["Process (safe)"]\nB -.-> C',
  },
  {
    name: "unicode CRLF offsets",
    source: "flowchart RL\r\nא[שלום (עולם) 🧪] -> 乙[读取 (本地)]\r\n",
    expected: 'flowchart RL\r\nא["שלום (עולם) 🧪"] --> 乙["读取 (本地)"]\r\n',
  },
  {
    name: "comments and styles",
    source:
      'flowchart LR\n%% A[Read (local)] -> B\nA[Read (local)]:::data -> B["C4Context"]\n%% Keep -> unchanged\nclassDef data fill:#eee,color:#333333',
    expected:
      'flowchart LR\n%% A[Read (local)] -> B\nA["Read (local)"]:::data --> B["C4Context"]\n%% Keep -> unchanged\nclassDef data fill:#eee,color:#333333',
  },
  {
    name: "frontmatter and metadata",
    source: '---\ntitle: "A -> B"\n---\n%% comment\naccTitle: A -> B\nflowchart LR\nA -> B',
    expected: '---\ntitle: "A -> B"\n---\n%% comment\nflowchart LR\naccTitle: A -> B\nA --> B',
  },
  {
    name: "directive preservation",
    source: '%%{init: {"flowchart": {"htmlLabels": false}}}%%\nflowchart LR\nA[Read (local)] -> B',
    expected:
      '%%{init: {"flowchart": {"htmlLabels": false}}}%%\nflowchart LR\nA["Read (local)"] --> B',
  },
  {
    name: "sequence separator",
    source: "sequenceDiagram\nparticipant A\nparticipant B\nA->>B Hello",
    expected: "sequenceDiagram\nparticipant A\nparticipant B\nA->>B: Hello",
  },
  {
    name: "sequence Unicode and activation",
    source:
      "sequenceDiagram\nparticipant א as שלום\nparticipant 乙 as Server\nא->>+乙 Hello (world)\n乙-->>-א Finished",
    expected:
      "sequenceDiagram\nparticipant א as שלום\nparticipant 乙 as Server\nא->>+乙: Hello (world)\n乙-->>-א: Finished",
  },
  {
    name: "pie separators",
    source: 'pie showData\n"Dogs" 10\n"Cats"：20.5',
    expected: 'pie showData\n"Dogs": 10\n"Cats":20.5',
  },
  {
    name: "pie Unicode",
    source: 'pie\n"שלום（עולם）" 10\n"猫" : 5',
    expected: 'pie\n"שלום（עולם）": 10\n"猫" : 5',
  },
] as const;

export const unrecoverableFixtures = [
  "flowchart LR\nA(Start]", // choosing either shape would invent intent
  "flowchart LR\nA[Read (local)] -> B\nB --> C[", // one remaining structural issue
  "flowchart LR\nA[One [nested] label]",
  "A -> B", // no diagram type or direction guessed
  "flowchart\nA -> B",
  "sequenceDiagram\nA->>B Hello", // unknown participant boundaries
  "sequenceDiagram\nparticipant A\nparticipant B\nloop Work\nA->>B Hello", // missing end
  'pie\n"Dogs"', // no value guessed
  'pie\n"Dogs" 1,5', // no locale interpretation
  "erDiagram\nTHIS IS NOT VALID !!!",
  // A syntactically repairable link still cannot bypass the native edge limit.
  "flowchart LR\nN0 -> N1\n" +
    Array.from({ length: 501 }, (_, i) => `N${i + 1} --> N${i + 2}`).join("\n"),
] as const;
