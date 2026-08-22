# Stateful Scientific Compute Foundation

Status: Accepted architecture
Owner: Yaacov
Created: 2026-08-18
Purpose: Defines the architecture, domain model, transport boundary, persistence semantics, delivered foundation phases, and post-baseline capability roadmap for stateful interactive scientific compute sessions in Scient. Written as a companion to the accepted `scient-analysis-runtime-foundation.md`, which governs one-shot terminal execution.
Doc type: Architecture decision record
Implementation maturity: Phases 1-4 and the figure-viewing extension are committed and locally qualified on macOS
Product maturity: Phase 4 core workflow and the figure-viewing extension are owner-accepted locally
Release maturity: Not approved

## Planning Posture

The architectural decisions in this record are accepted. The delivered phases
and post-baseline capability roadmap remain reviewable: evidence may change
their ordering, gates, or concrete mechanisms without silently changing the
product principles and domain boundaries above them. Material architectural
changes must amend this record rather than drift through implementation.

## Document Rules

This document records the accepted architecture for a new stateful compute subsystem. It does **not**
replace the analysis runtime foundation, select a Python distribution, define a
final persisted schema or authorize a T3 divergence. Sections 1-22 state the
decision; the phase and verification sections distinguish implemented local
work from product/release acceptance.

**Accepted** means that the product principles, domain boundaries, and dependency
direction below are the basis for implementation. It does not mean that an
implementation phase, operating system, packaged application, user experience,
or release has passed its own acceptance gate. Later evidence may amend an ADR;
"accepted" is not a claim that the design can never change.

### Qualification status (2026-08-22)

Phases 1-4 are committed at the rebased feature baseline `c6a2f2eb75`, whose
history contains the current `origin/main` snapshot `e207eefe831e`. The
language-neutral figure-following, direct static-image actions, and dual-layout
extension continues through `fba89323a9`. The settings, authorization, RPC
gateway, client recovery/folding, project Compute surface, editor actions,
output viewing, and workspace refresh path are implemented, including explicit
caret-aware `# %%` cells and bounded transient live-variable inspection.

On this exact rebased source candidate, affected compute, contracts,
client-runtime, web, server, Python-bridge, and real-kernel/product suites pass,
as do affected typechecks, format, lint, seam and brand checks, production web
and desktop/server builds, exact bridge staging, release smoke, and Electron
smoke. The owner manually tested and accepted the core file-first workflow and
the figure-viewing, floating-card, layout, and direct-action extension on macOS.
Hosted cross-platform real-kernel evidence, installed packaged-app evidence,
required hosted checks, and release approval remain separate pending gates.
Local evidence does not imply them.

It coordinates with, but does not duplicate:

- `scient-analysis-runtime-foundation.md`, which owns one-shot terminal
  execution, the shared `@scientfactory/execution` kernel, and the
  `AnalysisRun` lifecycle;
- `scient-latex.md`, which owns the LaTeX build subsystem and its separate
  document-artifact revision model;
- `scientific-artifact-studio.md`, which owns artifact inspection,
  multi-representation figures, and composition; and
- the Scientific Python Environment Roadmap in the `Scient` planning repo,
  which owns Python-specific use-case scope.

### Update Policy

Update this document when the architecture, transport decision, persistence
model, or phase boundaries materially change. When the first product slice is
accepted, distill the stable architectural core into `docs/architecture/` and
shipped behavior into user-facing docs rather than treating this living
decision-and-roadmap record as either.

---

## 1. First-Principles Objective

The first implementation milestone was not a complete notebook platform,
package manager, artifact database, or new agent runtime. That boundary kept
the foundation small enough to prove, but it is not the long-term product
boundary. Native notebooks, managed environments, rich interactive outputs,
safe HTML, additional languages, and agent operation are first-class parts of
the scientific-computing vision described by the post-baseline capability
roadmap below.

The first required foundation was one dependable scientific loop:

1. Select a Python environment.
2. Start a persistent Python process.
3. Execute code repeatedly while variables remain available.
4. See text, errors, and figures.
5. Interrupt code without losing prior state.
6. Restart intentionally when a clean namespace is needed.
7. Preserve an honest execution record.
8. Never leave orphan processes or claim that lost memory survived.

The remaining capabilities build on that loop incrementally. Incremental means
that each receives an explicit contract and acceptance gate; it does not mean
that notebooks, rich representations, HTML, additional languages, or managed
environments are minor or optional product polish.

### 1.1 Project-centered scientific work

The ordinary project filesystem is the durable scientific workspace. Source
stays in normal project files and editors; computation does not create a second
notebook database or a hidden source tree. Running a selection, cell, file, or
console submission produces an execution associated with the project, source,
and session that caused it.

The first product surface keeps review connected to that source:

- text, errors, figures, and later tables appear in one project compute history;
- Python files provide **Code**, **Split**, and **Results** views, with execution
  initiated contextually from the file and the selected run shown beside its
  source by default;
- Split may arrange the same source and selected result side by side or stacked,
  with an accessible persisted presentation preference and bounded resizing;
  changing that presentation never creates a new execution or result identity;
- a figure opens through the ordinary typed viewer rather than a Python-only
  viewer;
- files created or changed by user code remain ordinary project files and use
  the workspace's existing read, write, conflict, refresh, and viewer lifecycle;
- compute-owned retained output stays operational history until a deliberate
  publication makes it a durable project result.

The separate project Compute surface is secondary session/history navigation,
not the primary authoring surface. Phase 4 does not put a generic scratch-code
composer there. A later scratch console, if justified by real workflows, must
be an explicit product capability rather than an always-present empty editor.

### 1.2 Stateful exploration and isolated reproducibility

Scient deliberately offers two execution actions:

- **Run in session** is incremental and stateful. It may depend on variables
  created by earlier executions in the same generation.
- **Run isolated** uses the existing `AnalysisRun` domain and starts from a clean
  process for stronger reproducibility.

Neither action replaces the other. The UI must state which one will run, and a
receipt must not present one stateful submission as independently reproducible
when it depended on prior in-memory work.

### 1.3 Polyglot and optional-runtime principle

Scient has one language-neutral compute experience while runtime acquisition,
dependencies, and licensing remain language-specific:

- The base application starts and remains useful with no scientific runtime
  installed.
- `@scientfactory/compute`, session persistence, provenance, output review, and
  project-result publication do not depend on Python, Jupyter, R, Julia,
  MATLAB, or a particular vendor.
- A language adapter discovers and verifies only its own runtimes. Absence or
  failure disables that capability, not Scient or another language.
- Discovery and verification never install packages, register kernels, accept
  licenses, or mutate an environment.
- A future Scient-managed runtime is an explicit, per-language, removable
  acquisition. It is never a universal download imposed on users who do not
  need it.
- Proprietary runtimes and licenses remain owned by their vendor and the user.
  Scient may discover and use an existing authorized installation; it does not
  bundle, activate, or silently consume a license.
- Jupyter is one reusable transport for compatible kernels, not the product
  architecture and not a requirement for every language. A transport host and
  the scientific runtime it supervises may be different installations; any
  app-owned bridge host is a separately gated, on-demand component.
- Capabilities are negotiated. A runtime may support execution, interrupt,
  restart, figures, variables, tables, or inspection independently, and clients
  show only actions the selected runtime truthfully supports.

Python is the first complete proof of this model, not a dependency inherited by
every future adapter.

#### 1.3.1 Scientific Computing settings

The existing application settings surface gains one adapter-driven
**Scientific Computing** page. It is the user control surface for optional
compute capabilities, not a Python-specific installer:

- The page lists the language adapters this build actually supports and lets a
  user enable or disable their exposure and automatic discovery independently.
- Each enabled adapter reports detected and explicitly configured runtimes,
  exact version/path identity, readiness, missing requirements, and truthful
  capabilities. Capabilities are reported by the adapter; they are not
  arbitrary feature toggles that can promise unsupported behavior.
- User settings may choose a default runtime for new work. A project or session
  still selects and records its exact runtime identity; changing a user default
  does not rewrite existing project history.
- Enabling a language does not install packages, download a runtime, accept a
  license, or mutate an environment. Any supported acquisition, repair, update,
  or removal action is explicit, language-scoped, and separately gated.
- Disabling a language stops offering it for new sessions without deleting its
  runtime or making prior executions and results unreadable.

Additional language adapters register into this same page. They do not create
parallel settings systems or require the page to gain language-specific domain
logic.

Language enablement and preferred-runtime configuration are
server-authoritative and scoped to the selected server environment. They use the
existing server settings lifecycle rather than browser-local storage or a
second compute settings store. Environment-level inspection reports configured
and PATH runtimes only; it does not claim to enumerate project-local runtimes.
The project Compute surface adds discovery rooted in that validated project,
including a project `.venv`, and records the exact selected runtime in the
session. A setting change therefore affects a future session, not the identity
or history of an existing one.

The product surface stays quiet and compact. Settings are an occasional setup
surface, not the scientist's daily workspace. In a project, Compute presents a
thin session/action header and gives the available space to the transcript,
diagnostics, and figures. It reuses the ordinary source editor, project tree,
and typed preview surfaces rather than creating compute-only copies. Idle state
is visually quiet; running, interruptible, failed, lost, and truncated states
are explicit without turning the surface into a monitoring dashboard.

The file Results view presents one selected run immediately. It prioritizes
figures, diagnostics, and text output and does not repeat the full submitted
code, revision hash, or other storage identifiers beside the editor. Compact
context states whether the run used the file, a selection, or a cell, its line
range when useful, and whether the buffer was unsaved. The exact submitted
bytes remain in the durable execution record as provenance rather than primary
result-page content.

The embedded file Results view does not nest the selected run in a second
execution card. A normal successful file run presents its figures and text
directly; compact run context appears only when it carries information such as
a selection, cell, unsaved buffer, running state, or failure. Figure cards are
peer results within that run. The separate project Compute history may retain a
source-labeled execution container because it spans files and supports opening
the originating source.

The selected execution remains authoritative for status, text, and diagnostics.
Its own figures replace any earlier visual as soon as they are retained. While
the newest execution for that file and session generation is still active, or
if it ends failed, cancelled, or lost, Results may keep the most recent earlier
successful figures visible so useful visual context does not flash away. That
fallback is explicitly labelled as belonging to the earlier execution and can
never survive a newer successful execution that produced no figures. Selecting
an older historical execution never mixes it with figures from another run.

Opening a figure separates immutable result evidence from mutable presentation.
The inline figure in Results always renders the retained bytes of that exact
execution. A full or floating viewer opened from the current result may instead
follow one stable, language-neutral figure reference:

- a generated project figure follows its normalized project-relative path and
  resolves through the ordinary workspace-file authority;
- a runtime display follows its language, saved full-file source path, and
  ordinal among runtime-display images only; and
- a historical result, dirty buffer, selection, cell, console execution, or
  image without stable provenance opens as an immutable retained snapshot.

Following is presentation state, not a second compute record and not a promise
that one session lives forever. The same reference may advance across session
lifetimes. Only a newer successful matching execution can advance it; failed,
cancelled, interrupted, or lost executions leave the last good revision in
place. A successful matching full-file execution that omits a followed runtime
display keeps the prior image visibly labelled as previous. Generated project
files are never declared stale merely because an unrelated execution did not
write them.

The actual full-viewer tab or floating card owns the follow lifetime. Closing or
replacing that surface stops the work, and passive reconciliation cannot reopen
it. Revision ordering includes session creation and execution submission, so a
late older asset read cannot roll a figure backward. A stream gap freezes live
decisions until durable sessions, executions, and outputs are reread. Generic
image viewers remain producer-neutral and keep the last decoded image visible
while a newer signed resource loads; compute does not add Python- or
MATLAB-specific behavior to shared viewer chrome.

Static figure actions also remain producer-neutral and separate two concerns:
presentation destinations open the retained figure in the ordinary full viewer
or floating card, while file operations copy or download the exact retained
bytes. Adding a language or representation must reuse or extend that shared
action contract rather than introduce a Python-, MATLAB-, or renderer-specific
menu. Opening, floating, copying, or downloading a figure does not mutate its
execution record or project source.

Source freshness is compact execution context, not a banner or a hash display.
Dirty submissions remain labelled as unsaved. A saved submission is labelled
`Source changed` only when the currently open file has unsaved edits or its
saved revision no longer matches the execution's recorded revision. The exact
submitted bytes and hashes remain durable provenance rather than result-page
decoration.

Runtime diagnostics retain their bounded raw traceback and may also carry
bounded structured frames. Frame extraction happens at the language-adapter
boundary with the server-derived project root and submitted-source context;
only paths resolved inside that authorized project become relative, clickable
source locations. The client renders those locations but never parses arbitrary
traceback text into filesystem authority.

The file editor has one contextual primary run action. Exact selected text wins;
otherwise the caret selects the surrounding explicit `# %%` cell; without an
explicit cell, the whole current buffer runs. Marker lines are delimiters and
are never submitted. A caret inside a cell gives its submitted body a quiet,
theme-aware active tint, a slightly stronger gutter indication, and a
gutter run action. A non-collapsed text selection suppresses that active-cell
treatment because the selection is then the execution target. Pointer hover
never changes the active cell, and cell navigation must not replace normal
caret placement, text selection, or editing. Cmd/Ctrl+Enter resolves through
the same target rule so the toolbar, gutter, keyboard, and highlight cannot
disagree.

When the live adapter negotiates the optional `variables` capability, Results
may expose a secondary **Variables** view of the current namespace. It is a
bounded, generation-scoped summary (name, type, shape/size, and a safe preview
when available), not a value serializer or a historical artifact. It refreshes
after terminal executions, including failures, clears on restart, and is never
shown as belonging to an older session. Adapters must not invoke arbitrary
user-defined representations or properties to enrich it; unsupported values
remain named and typed with no preview.

Durable execution records remain authoritative, while bounded live events make
the selected result responsive. A cached durable read must not hide newer live
output: the client reconciles both by output sequence and rereads durable state
after a detected stream gap. This is state reconciliation, not polling or a
second history store.

### 1.4 Source and execution authority

Saved project files are authoritative for durable project source. The exact
submitted bytes and their content hash in `ComputeExecution` are authoritative
for what actually ran.

A document execution therefore records whether the submission matched the
saved file or came from a dirty buffer, plus its base saved revision and source
range when available. A human may intentionally execute unsaved code; an agent
normally begins from saved project files. Both use the same execution model,
but Scient never claims that dirty submitted bytes came from the current saved
revision.

### 1.5 Human and agent use one scientific system

Agent access is a later capability, not a parallel compute product. A provider
thread remains the conversation; `ComputeSession` remains the project scientific
resource. Manual and agent-triggered executions use the same service, lifecycle,
history, outputs, viewers, project files, and publication model.

Attribution and authorization differ. Agent sessions are bound to a host-derived
operation envelope and remain separate from human or other-provider sessions
unless an explicit sharing grant exists. The ordinary project compute surface
shows who initiated an execution and lets an authorized user inspect, interrupt,
restart, or stop it. No separate agent-only result store or review dashboard is
introduced.

A thread may hold navigation state for an open Compute panel, but it does not
own or partition the project session. Opening the same project's Compute surface
from two threads reads the same authorized project history.

---

## 2. Preserve Existing Execution Concepts

Scient already has two distinct execution systems. This decision adds a third.

| System           | Purpose                                  | Lifecycle                                                |
| ---------------- | ---------------------------------------- | -------------------------------------------------------- |
| `AnalysisRun`    | Isolated, terminal file/task execution   | One process, one exit code, one terminal result          |
| `DocumentBuild`  | Revision-bound LaTeX/document production | Build → publish → binding lifecycle                      |
| `ComputeSession` | Long-lived interactive namespace         | Many executions, persistent variables, interrupt/restart |

### Why they remain separate

A one-shot analysis run has one process, one exit code, one terminal result,
and reproducibility through a fresh start. A compute session has one long-lived
runtime, many code executions, variables retained in memory, interrupt and
restart as separate operations, rich outputs that can change in place, and no
process exit code for an ordinary code execution.

They should share low-level components only where the semantics are genuinely
identical: process spawning, process-tree cancellation, output bounding,
atomic writes, artifact hashing, and resource telemetry. They must not share
receipts, lifecycles, or persistence models.

The existing `scient-analysis-runtime-foundation.md` explicitly states:
_"When the second real consumer exposes genuinely shared server orchestration,
lift that behavior into an `ExecutionCoordinator`; do not make `DocumentBuild`
depend on `AnalysisService`, and do not force either specialized receipt into
a generic task record."_ This proposal follows that guidance: `ComputeSession`
is a sibling specialization, not a mode inside `AnalysisRun`.

---

## 3. Initial Product Slice

### Build now

- An adapter-driven Scientific Computing settings page, initially exposing
  Python enablement, runtime discovery/configuration, readiness, and defaults.
- Explicit Python executable selection and verification.
- One live stateful session per project, with durable prior session lifetimes.
- Run selection, cell, or file code from the ordinary Python editor.
- Persistent variables between executions.
- Bounded transient inspection of the current live namespace.
- Standard output and standard error.
- Structured Python tracebacks.
- Static PNG/SVG figures from Matplotlib, seaborn, explicit display values, and
  supported project images created or changed by the execution.
- FIFO execution ordering.
- Cancel queued execution.
- Interrupt active execution.
- Restart and clear the namespace.
- Stop the session.
- Durable local execution history.
- Historical transcript after app restart or kernel failure.
- Reliable process-tree cleanup.
- Authenticated remote operation through existing operate scopes.

### Deferred from the first Python product slice

The following capabilities were excluded from Phase 4 to protect the initial
foundation. They remain substantial roadmap commitments or explicit product
decisions, not a list of low-priority extras:

- Managed Python installation.
- Agent execution (requires operation envelope).
- Rich variable drill-down, editing, array slicing, and table browsing.
- A complete representation pipeline, including Plotly, Vega/Vega-Lite,
  document formats, structured data, supported media, and safe HTML.
- Native project-file notebook editing and execution.
- Stateful widgets and comms, behind a separate protocol and trust gate.
- Interactive stdin.
- Full mobile UI.
- Multiple user-visible sessions per project.
- R, Julia, or MATLAB sessions.
- Cross-domain artifact refactoring.

The underlying identifiers, session lifecycle, persistence, and output model
support these additions without a domain redesign. A real second-language
adapter may still justify a typed transport-specific launch extension; the fake
language-boundary test does not pre-approve that detail.

For the initial Python adapter, **Run cell** recognizes the bounded `# %%`
source convention and excludes the marker from submitted code. Cell parsing is
a Python source-adapter behavior, not a universal session or settings rule;
future languages supply their own source semantics without changing the shared
compute domain. Files without explicit markers remain ordinary files and do not
gain implicit notebook cells.

---

## 4. Domain Model

### 4.1 Compute session

A `ComputeSession` represents one live scientific runtime.

It records:

- `sessionId` — unique identifier.
- `projectId` — the project this session belongs to.
- User-visible label.
- Language (e.g. `"python"`).
- Runtime profile (executable, version, architecture).
- Working directory.
- Environment fingerprint.
- Session generation (incremented on each restart).
- Lifecycle state.
- Activity state.
- Active execution.
- Pending execution count.
- Process identity (bridge PID, kernel PID).
- Creation and last-activity timestamps.

The first UI exposes at most one live session per project. Every new lifetime
gets a fresh real session ID; stopped, failed, and lost lifetimes remain durable
and inspectable. This avoids overwriting a transcript while keeping the initial
choice surface simpler than a multi-session UI. Additional simultaneous
sessions can be added later without migration.

### 4.2 Session generation

Generation starts at 1 and increases after every restart.

Every public mutating request carries `sessionId` and `expectedGeneration`.
Inside a session-scoped transport channel, `sessionId` is implicit but
`expectedGeneration` remains explicit. This prevents a stale browser or
delayed command from executing code in a newly restarted namespace.

### 4.3 Session lifecycle

```text
starting → ready → restarting → ready
                 → stopping → stopped
                 → failed
                 → lost
```

- `starting`: Bridge or kernel is launching.
- `ready`: Session can accept work.
- `restarting`: Old namespace is being destroyed and replaced.
- `stopping`: Graceful shutdown is underway.
- `stopped`: Session was deliberately terminated.
- `failed`: Startup or controlled lifecycle operation failed.
- `lost`: The server can no longer communicate with a previously live runtime.

### 4.4 Session activity

```text
idle | busy | unresponsive
```

Activity is separate from lifecycle because:

- A ready session can be idle or busy.
- A failed liveness check makes it lost. `unresponsive` is used when an
  interrupt was delivered but the execution did not settle inside its bounded
  window; it clears when the runtime next settles or is replaced.
- A failed execution does not mean the session failed.

### 4.5 Compute execution

A `ComputeExecution` records:

- `executionId`
- `sessionId` and session generation
- Exact submitted code and SHA-256 content hash
- Source origin (file, selection, cell, console)
- Saved/dirty buffer state, base file revision, and source range where available
- Queue position
- Start and finish times
- Terminal state
- Diagnostics
- Output references
- Environment fingerprint
- Later, operation provenance

### 4.6 Execution lifecycle

```text
queued → submitting → running → succeeded
                            → failed
                            → interrupting → cancelled
                            → cancelled (restart or shutdown destroys namespace)
                            → lost
```

Rules:

- One execution runs at a time in each session.
- Submissions are processed in FIFO order.
- Queued executions can be cancelled without reaching Python.
- A Python exception fails the execution, not the session.
- Interrupt preserves namespace state created before the interrupted operation.
- Restart clears the namespace and cancels queued work.
- Kernel death marks the active execution `lost`.

---

## 5. Package and Dependency Architecture

### 5.1 New package

```text
packages/scient-compute/
```

Published internally as `@scientfactory/compute`.

Contains only:

- Domain identifiers (session IDs, execution IDs, generation).
- Session and execution state machines with legal-transition tables.
- Output contracts (stream, diagnostic, image, system).
- Runtime capability negotiation.
- Transport port (`ComputeTransport`).
- Language adapter port (`ComputeLanguageAdapter`).
- Variable descriptor contracts (reserved for later use).
- Deterministic simulator (`createSimulatedComputeTransport`).
- Pure transition and output-folding helpers.
- Framed protocol codec (encoder/decoder for bridge messages).

It must not depend on:

- Python, Jupyter, or any language-specific runtime.
- Node filesystem or process APIs.
- Server code or Effect layers.
- UI code.
- `@scientfactory/analysis`.

Dependencies:

```text
@scientfactory/compute → @scientfactory/execution (identifiers only)
@scientfactory/compute → effect (Schema, Effect, Stream)
```

### 5.2 Server implementation

```text
apps/server/src/scient/compute/
  ComputeSessionService.ts       — coordinator: registry, queue, lifecycle, supervision
  LocalComputeStore.ts           — canonical filesystem persistence
  ComputeSessionIndex.ts         — optional rebuildable projection when measured scale requires it
  PythonRuntimeAdapter.ts        — discovery, verification, fingerprinting, diagnostics
  ComputeEnvironmentPolicy.ts    — environment sanitization and project scoping
  JupyterBridgeTransport.ts      — implements ComputeTransport over the bridge
  BridgeProtocol.ts              — framed message codec and handshake
  bridge/
    scient_compute_bridge.py      — single-file sidecar using jupyter_client
```

### 5.3 Client implementation

```text
packages/client-runtime/src/state/compute.ts
apps/web/src/scient/compute/
```

### 5.4 State directory

Extend `ServerConfig` with:

```text
computeDir: <stateDir>/compute
```

Created at boot alongside `analysisDir` and `latexDir`.

### 5.5 Dependency direction

```text
@scientfactory/execution
    ← @scientfactory/analysis (existing)
    ← @scientfactory/compute (new)

@scientfactory/contracts
    ← @scientfactory/analysis + @scientfactory/compute
```

`@scientfactory/compute` must not import `@scientfactory/analysis`. Shared
diagnostics or representations move into neutral packages only after concrete
duplication is demonstrated, not preemptively.

---

## 6. Duplex Process Foundation

### 6.1 Why it is needed

The existing `ExecutionProcessPort` can start a process, read merged text
output, wait for exit, and cancel the process tree. It has no stdin/write
capability, decodes stdout/stderr as text, merges output streams, does not
expose PID, and is designed for a command that exits.

A bridge requires continuous bidirectional communication: the server must
send execute, interrupt, restart, and shutdown commands while the process
remains alive, and must receive framed binary protocol output on a separate
channel from diagnostic stderr.

### 6.2 New port

Add a sibling interface to `@scientfactory/execution`:

```ts
interface DuplexProcessRequest {
  processId: string;
  executable: string;
  args: ReadonlyArray<string>;
  cwd: string;
  environment: Readonly<Record<string, string>>;
}

interface DuplexProcessHandle {
  readonly pid: number;
  readonly stdout: Stream<Uint8Array>;
  readonly stderr: Stream<Uint8Array>;
  readonly write: (bytes: Uint8Array) => Effect<void>;
  readonly exitCode: Effect<number>;
  readonly cancelProcessTree: Effect<void>;
}
```

The duplex handle deliberately does not expose `closeInput`. A responsive
bridge leaves through a framed shutdown request it understands; an
unresponsive bridge is removed through `cancelProcessTree`. Keeping stdin open
also lets each serialized `write` report whether its bytes reached the
operating system. A queue-backed writer whose EOF can be closed independently
would detach delivery failures from the request that caused them.

### 6.3 Implementation

Refactor the process spawning internals so that:

- `LocalExecutionProcess` retains its current public behavior unchanged.
- `LocalDuplexProcess` exposes stdin and binary streams.
- Both use the same no-shell spawning policy.
- Both use the same detached Unix process groups.
- Both use Windows process-tree cancellation (`taskkill /T /F`).
- Both use the same graceful (SIGTERM + 5s) and forced termination deadlines.

This improves the foundation without forcing existing consumers onto a more
complex interface. The existing `documentBuildBoundary.test.ts` pattern
proves the shared execution kernel remains language-neutral; a similar test
should prove the duplex port is also independent of compute contracts.

---

## 7. Bridge Transport

### 7.1 Why a bridge

Implementing the Jupyter wire protocol directly in TypeScript would require
Scient to own ZeroMQ socket behavior, multipart message framing, HMAC signing,
shell/IOPub/control/stdin/heartbeat channel routing, connection-file
management, kernel restart behavior, platform-specific interruption, and
subtle protocol ordering and compatibility cases.

A bridge based on the reference `jupyter_client` implementation avoids that
risk. The bridge is a protocol translator that never runs user code — user
code runs in the kernel process the bridge launches.

### 7.2 Bridge responsibilities

The bridge:

- Starts and supervises the selected kernel using `jupyter_client`.
- Manages Jupyter connection files and HMAC keys.
- Owns shell, IOPub, control, stdin, and heartbeat channels.
- Translates Jupyter messages into a stable Scient protocol.
- Sends execute, interrupt, restart, completion, inspection, and shutdown
  commands.
- Reports bridge and kernel process IDs.
- Starts concurrent protocol-stdout and diagnostic-stderr drains immediately
  after spawn, before sending any request, so pipe backpressure cannot deadlock
  a bridge trying to answer.
- Enforces protocol frame-size limits before sending data to Node.
- Removes connection files during shutdown.
- Does not exit cleanly until every runtime process it started has stopped;
  process-tree cancellation is the fallback while the bridge supervisor is
  still live, not a way to recover descendants from a vanished leader.
- Exits if its parent server connection closes (parent-death watchdog).

### 7.3 Initial bridge runtime strategy

For the technical proof and initial development, run the bridge using the
selected Python environment. That environment must contain `jupyter_client`
and `ipykernel`.

This avoids committing immediately to shipping and maintaining a separate
app-owned Python runtime. The transport architecture uses a
`BridgeLauncher` boundary so the bridge can later run from an app-owned
packaged runtime without changing session contracts or orchestration.

### 7.4 Framed protocol

Use length-prefixed JSON, not NDJSON:

```text
4-byte big-endian payload length
UTF-8 JSON payload
```

Every message includes:

- Protocol version.
- Message type.
- Request ID (correlates shell replies and IOPub output).
- Session ID.
- Session generation.
- Monotonic sequence.
- Payload.

Stderr is reserved for bounded bridge diagnostics, separate from protocol
output.

The streaming decoder must be finalized when protocol stdout ends. EOF with a
partial length header or payload is a truncated frame and fails the transport;
it is never treated as orderly bridge shutdown.

### 7.5 Why framing matters

- Reliable partial-read handling (TCP and pipe writes can split at any
  boundary).
- Explicit message-size enforcement.
- Clear malformed-message failure.
- Multiline JSON without escaping assumptions.
- A path to binary payloads later.
- Separation between protocol stdout and diagnostic stderr.

### 7.6 Handshake

Before starting a kernel, the server and bridge exchange:

- Protocol version.
- Bridge build identity.
- Supported commands and capabilities.
- Maximum frame size.
- Runtime platform.
- Owner token (for stale-process validation).

A version or capability mismatch fails closed before user code runs.

### 7.7 Why packaging remains a separate decision

Shipping an app-owned bridge runtime requires decisions about Python
distribution, native ZeroMQ libraries, platform/architecture builds, signing
and notarization, updates, vulnerability response, license notices, and
packaged-app size. The bridge boundary permits this later, but the first
implementation should generate evidence before committing to that subsystem.

If evidence requires one, it is acquired as an explicit Jupyter-transport
component rather than folded into the base Scient installation. Languages that
do not use that transport do not acquire it, and a bridge host does not become
the authority for which language runtime or licensed installation the user
selected.

---

## 8. Python Environment Model

### 8.1 Ownership

A compute session belongs to one Scient server environment, one project, one
selected runtime, and one working directory. It is not automatically the same
environment used by a connected provider agent. Existing agent shell execution
remains unchanged.

### 8.2 Initial discovery

Use a bounded discovery order:

1. Explicitly configured executable (saved in `runtime-settings.json`).
2. Project-local `.venv`.
3. Python executable on the server's `PATH`.
4. Limited conventional platform locations if needed.

Do not begin with complete conda, mamba, pyenv, environment-module, and WSL
management.

### 8.3 Verification

Verification reports:

- Canonical executable path.
- Python version, implementation, and architecture.
- `sys.prefix`.
- `jupyter_client` availability and version.
- `ipykernel` availability and version.
- Kernel startup success.
- Selected relevant scientific package versions.
- Actionable failure category.

Failure examples:

- Executable missing.
- `jupyter_client` missing.
- `ipykernel` missing.
- Unsupported Python version.
- Startup timeout.
- Architecture problem.
- Environment inaccessible.

Scient must not silently install packages or modify the environment.

### 8.4 Environment fingerprint

Record a bounded fingerprint:

- Executable identity (canonical path, modification time).
- Python version and architecture.
- `sys.prefix`.
- `ipykernel` and `jupyter_client` versions.
- Selected scientific package versions (e.g. numpy, pandas, matplotlib).
- Relevant project lockfile revisions when available.

Do not run a complete `pip freeze` after every execution.

### 8.5 Environment sanitization

Add `ComputeEnvironmentPolicy` that:

- Launches the exact selected executable without shell activation.
- Sets the project working directory explicitly.
- Removes server control variables.
- Removes pairing, provider, cloud, and internal authentication tokens known
  to Scient.
- Does not persist the resulting environment.
- Never logs environment values.
- Adds only required bridge/session variables.
- Applies platform-specific variables required for the selected environment.

This is defense in depth, not a sandbox. Python code still has the
operating-system permissions of the Scient server process.

### 8.6 Runtime delivery and licensing

The initial Python slice is bring-your-own-runtime: it uses an explicitly
selected or boundedly discovered environment and reports missing requirements
without changing it. Later delivery choices remain separate product decisions:

- An app-managed Python, R, Julia, or bridge environment is optional,
  independently versioned, downloaded only after explicit consent, and
  removable without affecting projects or other runtimes.
- A project may declare or recommend an environment, but opening the project
  never installs it or accepts terms on the user's behalf.
- A proprietary adapter records availability and actionable license/setup
  failure without copying vendor binaries, storing license secrets, or treating
  an unavailable license as an application failure.
- Transport support and kernel support are resolved separately. A user of an R
  or Julia kernel must not be forced to select Python as the scientific runtime
  merely because a Jupyter bridge happens to be implemented in Python.

---

## 9. Transport and Language Adapter Ports

### 9.1 Compute transport

```ts
interface ComputeTransport {
  open(request: TransportOpenRequest): Effect<ComputeChannel, ComputeTransportError, Scope>;
}

interface ComputeChannel {
  readonly events: Stream<TransportEvent>;
  execute(request: ExecuteRequest & GenerationPrecondition): Effect<void>;
  interrupt(request: InterruptRequest & GenerationPrecondition): Effect<void>;
  restart(request: RestartRequest & GenerationPrecondition): Effect<void>;
  shutdown(request: GenerationPrecondition): Effect<void>;
}
```

Completion and inspection are optional capabilities represented in the
transport contract and added when needed.

The channel already identifies the session. Every mutating command still
carries `expectedGeneration`, and restart also carries the exact next
generation, so delayed commands cannot act on a replacement namespace.

### 9.2 Language adapter

```ts
interface ComputeLanguageAdapter {
  readonly languageId: string;
  readonly transportKind: string;

  discover(...): Effect<ReadonlyArray<RuntimeProfile>>;
  verify(...): Effect<RuntimeVerification>;
  prepareLaunch(...): Effect<ComputeLaunchPlan>;
  normalizeDiagnostic(...): ReadonlyArray<ComputeDiagnostic>;
  fingerprintEnvironment(...): Effect<EnvironmentFingerprint>;
}
```

Variable inspection is an optional channel capability whose safe summary is
language-specific. The adapter advertises support; the coordinator enforces
generation, idle-state, and authorization policy without learning Python
namespace semantics.

The coordinator, not the language adapter, constructs `TransportOpenRequest`.
This keeps session identity, generation, transport selection, and required
capabilities under session policy; the adapter owns only language-specific
launch preparation.

`ComputeLaunchPlan.executable` names the process the transport supervises. In
the initial Python adapter, the selected Python executable is both the bridge
host and the kernel interpreter. That is an implementation economy, not a
cross-language invariant. A later Jupyter adapter for R or Julia must identify
the exact selected kernel independently from any Python bridge host; it must not
pretend that an R executable itself speaks the Scient bridge protocol. The
first real second-language adapter is the gate for adding a typed
transport-specific launch configuration if the current plan is insufficient.

### 9.3 What belongs in an adapter

- Runtime discovery.
- Environment verification.
- Startup configuration.
- Diagnostics and traceback mapping.
- Working-directory behavior.
- Variable inspection (later).
- Environment fingerprinting.
- Language-specific capabilities.

### 9.4 What does not belong in an adapter

- Session lifecycle.
- Queuing.
- Journaling.
- Artifact publication.
- RPC.
- Authorization.
- Client subscriptions.
- General output retention.

### 9.5 Fake cross-language proof

The pure compute package includes:

- A fake non-Jupyter transport (simulator).
- A fake second-language adapter.

Together they prove that the coordinator lifecycle and adapter contract are not
Python-specific. They do **not** prove that the current Python-hosted Jupyter
launch plan can start R or Julia. A real second-language adapter and kernel are
the integration proof for bridge-host/kernel separation; the fake test must not
claim it.

### 9.6 Jupyter does not eliminate language adapters

Jupyter eliminates repeated transport work for Python, R, and Julia. It does
not eliminate runtime discovery, environment selection, startup
configuration, capability negotiation, working-directory behavior, diagnostic
normalization, variable inspection, or language-specific bootstrap behavior.

The correct exit gate for adding R is:

> R reuses the coordinator, persistence, output pipeline, and Jupyter
> transport; its adapter discovers and verifies an exact R runtime and the
> transport launches that kernel without making Python the selected scientific
> environment.

Not:

> R is only a kernelspec name and snippet.

---

## 10. Output Model

### 10.1 Initial output types

The first product slice supports:

```ts
type ComputeOutput =
  | StreamOutput // stdout/stderr text
  | DiagnosticOutput // exception type, message, traceback frames
  | ImageOutput // static PNG/SVG figure with content hash and signed resource
  | SystemOutput; // session started, interrupted, restarted, lost, truncated
```

### 10.2 Scientific representation platform

Static PNG/SVG is the first rendered slice, not the final output model. The
shared compute domain must grow into a bounded representation bundle that can
retain multiple representations of one logical result and let the client choose
the highest-fidelity renderer it safely supports. Renderer selection belongs to
a Scient-owned representation registry, not to Python conditionals or a
Jupyter-shaped UI.

The roadmap includes these important representation families:

- text and documents: plain text, Markdown, LaTeX, and PDF;
- static images: PNG, JPEG, WebP, and validated SVG;
- structured values: JSON, arrays, records, tables, and an efficient bounded
  tabular interchange when justified;
- declarative interactive figures: Plotly, Vega, and Vega-Lite specifications;
- supported audio and video through the ordinary typed media viewers;
- HTML documents and fragments through an explicit sanitization, sandbox,
  origin, content-security, network, and navigation policy; and
- stateful widgets and comm-backed views through a separate capability and
  lifecycle contract rather than by treating them as ordinary HTML.

The contract also reserves display updates (`update_display_data` with a stable
display identity), clear-output semantics (including delayed clear), and input
requests. A representation bundle records media type, bounded bytes or a signed
resource, content hash, validation status, and immutable execution provenance.
Unknown or unsupported representations retain a truthful bounded fallback when
available; they must not cause execution failure or silently gain script
authority.

First-class HTML support does not mean unsandboxed HTML. Inert or sanitized
HTML may ship before active documents. Any executable HTML or widget support
requires an isolated execution context with no ambient Scient origin, storage,
credentials, filesystem authority, or host APIs, plus an explicit user-visible
trust decision where one is necessary.

The initial bridge normalizes Jupyter messages correctly even when the client
does not yet render every representation. Later adapters may produce the same
neutral representation contracts without using Jupyter.

### 10.3 Completion correlation

An execution succeeds only after the server observes:

- Its matching shell `execute_reply`.
- Its matching IOPub `idle` status.

Correlation uses Jupyter parent-message IDs.

The transport must handle:

- Reply arriving before idle.
- Idle before locally folded completion.
- Unrelated kernel messages.
- Parentless asynchronous output.
- Output arriving after idle.
- Kernel death during execution.

Parentless asynchronous output becomes session-level output rather than being
falsely attributed to an execution.

### 10.4 Stdin

Launch executions with stdin disabled initially. If Python requests input,
return a clear unsupported-input diagnostic. Do not leave the execution
waiting indefinitely.

Interactive stdin can be added later with an explicit request/reply UI and
timeout model.

---

## 11. Initial Compute-Owned Output Storage

### 11.1 Avoid premature shared-package migration

Do not create `@scientfactory/artifacts` before the first compute slice.
Instead, define a compute-owned representation contract for static PNG and SVG output:
content hash, byte length, file name, producer execution, and signed-resource
identity.

This avoids changing existing analysis and document-artifact contracts
before compute proves its needs.

### 11.2 Physical layout

```text
compute/
  sessions/
    <projectId>/
      <sessionId>/
        executions/
          <executionId>/
            outputs/
```

Outputs remain colocated with the execution that produced them. This
preserves atomic publication with the producing receipt, simple cleanup,
independent retention policies, and straightforward crash recovery.

### 11.3 Signed asset resource

Add a narrow resource to `AssetResource`:

```ts
{
  _tag: ("compute-output", projectId, sessionId, executionId, outputId);
}
```

`AssetAccess` resolves it only after:

- Loading authoritative output metadata.
- Canonicalizing the file path.
- Confirming it remains under `computeDir`.
- Verifying expected size and revision information.

### 11.4 Later extraction gate

After compute supports multiple representations, compare it with analysis
artifacts. Extract a neutral artifact package only if both systems
demonstrably share representation identity, media validation, content
hashing, publication, resolution, and cleanup behavior.

Generated document bindings remain separate because their
revision/current/stale semantics are genuinely different.

---

## 12. Compute Session Service

Add `ComputeSessionService` under `apps/server/src/scient/compute/`.

### 12.1 Responsibilities

It owns:

- Live session registry.
- Startup single-flight behavior (idempotency key prevents duplicate kernels).
- Session generations.
- Execution queue.
- Transport supervision.
- Output correlation.
- Interrupt and restart.
- Graceful and forced shutdown.
- Event sequencing and PubSub fanout.
- Persistence.
- Historical reads.
- Recovery.
- Resource limits.

### 12.2 Initial session policy

The UI exposes at most one live Python session for each project. Internally:

- The client mints one bounded, path-safe session ID for a start attempt so a
  retry is idempotent without reusing a completed history.
- Reusing that live ID is idempotent only when language, working directory, and
  configured runtime match the original start request; an incompatible retry is
  a typed conflict and cannot return or replace the existing runtime.
- A new start after stop, loss, or failure uses a fresh session ID.
- APIs accept session IDs and storage is session-scoped.
- Historical session lifetimes remain selectable and readable.
- The session service atomically rejects a second distinct live session for the
  same project; the domain and persistence do not assume the project can never
  have another session in a later multi-session product.

### 12.3 Queue

Initial engineering policy:

- One active execution per session.
- Maximum 16 pending executions.
- FIFO order.
- Explicit queue positions.
- Cancel by execution ID.
- Typed queue-full error.
- Restart cancels queued work.

### 12.4 Interrupt

1. Mark the execution `interrupting`.
2. Send a control-channel interrupt.
3. Wait for the kernel to return to idle (bounded deadline).
4. Mark the execution `cancelled`.
5. Keep the session `ready`.
6. Preserve prior namespace state.

If the kernel remains unresponsive, Scient reports that condition and offers
restart. It does not silently destroy the namespace.

### 12.5 Restart

1. Reject new submissions temporarily.
2. Cancel queued work.
3. Restart the kernel.
4. Mark active work `cancelled` only after controlled replacement is proven;
   otherwise lose it with the session.
5. Increment the generation only after the replacement is ready.
6. Emit a visible namespace-cleared marker.
7. Return the session to `ready`/`idle`.

### 12.6 Shutdown

1. Reject new work.
2. Cancel queued executions.
3. Request graceful kernel shutdown.
4. Wait up to 5 seconds per bridge shutdown stage, under a 15-second transport
   round-trip deadline.
5. Cancel the entire bridge/kernel process tree.
6. Persist the final lifecycle state.

---

## 13. Focused Persistence

### 13.1 Canonical filesystem layout

```text
stateDir/compute/
  runtime-settings.json
  sessions/
    <projectId>/
      <sessionId>/
        session.json              — atomic session metadata
        journal.ndjson            — append-only lifecycle events
        executions/
          <executionId>/
            request.json          — submitted code, source, hash
            result.json           — terminal state, timing, diagnostics
            output.ndjson         — append-only output events
            outputs/              — PNG and other produced files
```

### 13.2 What is persisted

- Session identity, runtime, and generation.
- Execution code, hash, and source provenance.
- Environment fingerprint.
- Ordered lifecycle events.
- Text output.
- Diagnostics.
- Static-image media type, metadata, and content hash.
- Terminal execution state.
- Explicit truncation markers.

### 13.3 What is not persisted

- Arbitrary Python namespace objects.
- Jupyter HMAC keys or connection files.
- Environment-variable contents.
- Credentials.
- Claims that a kernel can be resumed after process loss.
- Hidden variable-inspection code.

### 13.4 Recovery

After app or server restart:

- Previously live sessions become `lost`.
- Active executions become `lost`.
- Queued executions become `cancelled`.
- Historical executions remain visible.
- A new kernel starts only after an explicit user action.
- No code is replayed automatically.

### 13.5 Initial indexing

The first slice loads the bounded history of one project session directly from
canonical files. Before retained history becomes unbounded, add:

- SQLite session index.
- SQLite execution index.
- Keyset pagination.
- Dirty-generation tracking.
- Index rebuild from canonical files.
- Metadata-preserving cleanup.

This keeps SQLite off the critical proof path without abandoning the
scalable storage model. Follow the existing `AnalysisRunIndex` pattern:
rebuildable projection, not canonical truth.

---

## 14. RPC and Authorization

### 14.1 Initial RPC methods

Runtime:

- `compute.inspectRuntimes`
- `compute.verifyRuntime`

Session:

- `compute.startSession`
- `compute.listSessions`
- `compute.getSession`
- `compute.restartSession`
- `compute.stopSession`

Execution:

- `compute.submitExecution`
- `compute.cancelExecution`
- `compute.interruptSession`
- `compute.listExecutions`
- `compute.listOutputs`

Subscription:

- `compute.subscribeSessions`

The public RPC boundary accepts a project working directory and resolves the
initialized project identity on the server. Clients do not choose authoritative
project identifiers, working directories, retained-compute paths, or session
ownership. Language preferences are written through the existing authenticated
server-settings RPC; there is no separate `compute.configureRuntime` persistence
path.

### 14.2 Authorization

Follow the existing `RpcAuthorization.ts` pattern:

Read scope (`AuthOrchestrationReadScope`):

- Runtime status.
- Session status.
- Historical executions and output.

Operate scope (`AuthOrchestrationOperateScope`):

- Explicit runtime verification.
- Start session.
- Execute code.
- Interrupt.
- Restart.
- Stop.

Compute execution can operate with the full OS authority of the server
process. It must never be available through unauthenticated or read-only
access. Existing authenticated remote clients with operate authority may use
it. The UI must disclose that code runs on the server machine with that
server's filesystem and network permissions.

### 14.3 Stale-command protection

Every mutating request includes `sessionId` and `expectedGeneration`. A stale
client receives a typed conflict instead of acting on a restarted kernel.

### 14.4 No agent access initially

MCP and provider agents receive no compute-session capability in the first
slice. Existing agent shell and Python execution remain unchanged.

---

## 15. Client Runtime and UI

### 15.1 Client runtime

Add `packages/client-runtime/src/state/compute.ts` containing:

- Runtime queries.
- Session query.
- Execution commands.
- Session subscription.
- Sequence watermark.
- Snapshot-plus-delta folding.
- Bounded transcript state.
- Historical loading.

Follow the structural pattern of `packages/client-runtime/src/state/analysis.ts`:
typed query/subscription atom families, `createEnvironmentRpcCommand` with
`singleFlight`/`latest` keys, `Stream.scan` folding of snapshot + delta events.

### 15.2 Initial UI

Provide:

- Python environment selector.
- Verification status and actionable errors.
- Session status (lifecycle + activity).
- Run button.
- A visible, labeled Interrupt button only while code is running; it keeps the
  session namespace.
- Quiet session actions while idle: restart and stop live in one labeled menu,
  and each confirms its namespace-loss consequence before proceeding.
- Execution transcript.
- stdout/stderr rendering.
- Structured traceback rendering.
- Matplotlib image output.
- Visible restart, interruption, loss, and truncation markers.
- One project compute history for manual work and later agent-attributed work;
  no provider-only transcript or result surface.
- Source association that returns from an execution to the ordinary file editor.
- Figures opened through the existing typed preview surface.
- A user-selectable side-by-side or stacked Split presentation with pointer and
  keyboard resizing; Code and Results remain available independently.

### 15.3 Editor actions

- Run selection in Python session.
- Run current cell in Python session.
- Run file in Python session.
- Run file isolated through the existing analysis system.
- Record whether selection/cell/file bytes match the saved revision or came from
  a dirty buffer; never autosave merely to make an execution easier to describe.

The UI should explain the difference:

- **Run in session:** fast and stateful, uses existing variables.
- **Run isolated:** fresh process, more reproducible.

Code executed in a session may create, modify, rename, or delete project files.
The Phase 4 acceptance flow must verify that those changes use the ordinary
workspace lifecycle: clean open files refresh, dirty buffers require an
explicit conflict decision, newly created files become discoverable, and
existing editors/viewers open the result. Compute does not infer artifacts by
parsing console text or classifying an unbounded project diff. The shared
compute coordinator owns a language-neutral, execution-scoped project-output
observer. Immediately before dispatch it records a bounded inventory of the
static image types the product can render; at the transport's terminal boundary
it retains only new or changed regular PNG/SVG files below the validated project
root. The observer excludes operational and dependency directories, never
follows symlinks, reports incomplete observation, and snapshots accepted bytes
through the same output limits, persistence, provenance, and signed viewer path
as explicit runtime display. Language adapters and transports remain responsible
only for runtimes and runtime messages, so a second language reuses this behavior
without implementing another filesystem scanner.

### 15.4 Client surfaces

Initial full UI:

- Web.
- Desktop (wraps web).

Mobile:

- Advertises compute UI as unsupported initially.
- Does not display broken or incomplete controls.
- Shared contracts and client-runtime design must not prevent later mobile
  support.

### 15.5 Multi-client behavior

The server owns sessions, so they continue when a client disconnects.

- Attach requires explicit `sessionId`.
- Commands use session generation preconditions.
- Subscriptions carry sequence watermarks.
- Clients detecting a sequence gap reload a snapshot or journal page.
- No client relies on local filesystem paths.
- Assets are retrieved through signed URLs.

---

## 16. Security Model

### 16.1 Explicit non-sandbox statement

A compute session is authorized local code execution, not a security sandbox.
Python can potentially access project files, other files allowed to the server
process, network resources available to the server, and user-level processes
and services.

### 16.2 Initial protections

- Require authenticated operate scope.
- Require an existing authorized project.
- Validate working directory against the project.
- Validate source references and revisions.
- Avoid shells when starting Python.
- Sanitize inherited environment variables.
- Never include secrets in persisted fingerprints or diagnostics.
- Contain output paths beneath `computeDir`.
- Use signed asset URLs.
- Bound protocol frames, code, output, queue length, and files.
- Disable interactive stdin.
- Do not expose compute to agents.

These controls protect Scient's boundaries. They do not claim to contain
malicious Python code.

---

## 17. Resource Limits

Treat these as initial engineering limits, not permanent product guarantees:

| Resource                       |               Initial limit |
| ------------------------------ | --------------------------: |
| Submitted code                 |                       1 MiB |
| Bridge frame                   |                      16 MiB |
| Pending executions             |                          16 |
| Single text output event       |                     256 KiB |
| Retained output per execution  |                       8 MiB |
| Retained output per session    |                      32 MiB |
| PNG decoded representation     |                       8 MiB |
| SVG UTF-8 representation       |                       8 MiB |
| Store image defense-in-depth   |                      32 MiB |
| Project-output inventory       |               4,096 entries |
| Project-output directory depth |                    8 levels |
| Project images per execution   |                          32 |
| In-memory recent transcript    | Bounded by events and bytes |
| Bridge shutdown stage          |                   5 seconds |
| Transport shutdown round trip  |                  15 seconds |
| Idle/running liveness interval |                    1 second |

Every truncation must produce a visible persisted marker.

Limits should be configurable in tests and evaluated using real scientific
workloads before general release.

---

## 18. Resource and Lifecycle Policy

### 18.1 Active work

An active execution is not stopped because the window loses focus, the app
enters the background, the machine switches to battery, or no client is
momentarily connected.

### 18.2 Idle sessions

Idle shutdown applies only when:

- No execution is active.
- The queue is empty.
- The idle timeout has elapsed.
- The host is not in a transient suspend/resume state.

Phase 3 defaults the idle timeout to disabled. Before product code enables it,
Phase 4 must add client leases and a visible warning; the current server-only
option is suitable for controlled hosts and tests, not a hidden product policy.

### 18.3 Concurrency

Candidate defaults:

- One serialized kernel startup per server in Phase 3; revisit only with
  measured startup latency and memory evidence.
- A configurable maximum number of live sessions is deferred until measured;
  Phase 3 has no hidden session-count eviction policy.
- One active execution per session.
- 16 queued executions per session.
- Bounded output and artifact storage.

### 18.4 Server shutdown

1. Reject new work.
2. Cancel queued executions.
3. Request graceful kernel shutdown.
4. Wait for a bounded deadline.
5. Cancel the entire bridge/kernel process tree.
6. Persist final lifecycle state.

### 18.5 Resource telemetry

Record bridge PID, kernel PID, session and project attribution, CPU and
memory usage where available, start time, and generation.

Stale-process cleanup validates PID, process start time, and owner token. It
never kills by executable-name matching.

---

## 19. Agent Execution and Operation Provenance

Agent execution is deferred until Scient has an accepted operation envelope.

### 19.1 Operation envelope

The envelope must contain host-resolved:

- Operation ID.
- Actor identity.
- Project scope.
- Capabilities.
- Authority generation.
- Parent operation or lineage.
- Issue and expiry information.

The server derives this from authenticated invocation context. The agent does
not submit its own authoritative actor identity.

The existing `scient-analysis-runtime-foundation.md` explicitly states:
_"Actor identity is deliberately not represented as a nullable execution-receipt
placeholder. Before agent- or automation-triggered runs land, the accepted
Scient operation envelope must supply the host-resolved actor, project scope,
capabilities, authority generation, and operation lineage; the result receipt
then binds to that envelope rather than trusting an analysis-RPC payload."_

### 19.2 Agent session ownership

Agent-created sessions are owned by environment, project, thread, provider
session, and operation lineage. An agent cannot attach to a user's interactive
session without an explicit future sharing grant.

Ownership changes neither the scientific record nor its review location.
Agent-triggered executions appear in the same project compute history, use the
same figure and file viewers, and publish through the same project-result
contract as manual executions. Attribution identifies the initiating actor and
operation; it does not create an agent-only session database or output UI.

### 19.3 Later MCP tools

- `compute_session_start`
- `compute_execute`
- `compute_session_status`
- `compute_variables`
- `compute_interrupt`
- `compute_session_stop`

These tools return structured execution results and artifact references
rather than requiring agents to scrape terminal output.

---

## 20. Delivered Phases and Capability Roadmap

Phases 0-4 form the one required vertical sequence: architecture, neutral
foundation, Python transport, durable service, then the first human product
loop. Work after Phase 4 is dependency-gated rather than numerically serialized.
Hardening, richer scientific affordances, additional language adapters, and the
agent pilot may advance independently when their stated prerequisites are met.
In particular, a real R adapter does not wait for agent support, and an agent
pilot does not wait for every rich renderer.

### Phase 0: Architecture record and focused spike

**Purpose:** Prove the hardest unknowns before committing to product
infrastructure.

**Implements:**

- This architecture decision document.
- Throwaway or isolated bridge prototype.
- Selected-environment startup.
- Framed request/reply protocol.
- Stateful Python execution.
- Matplotlib PNG capture.
- Interrupt.
- Restart.
- Process-tree cancellation.

**Proof scenario:**

1. Execute `x = 41`.
2. Execute `x + 1` and receive `42`.
3. Produce a Matplotlib figure.
4. Interrupt an infinite loop.
5. Confirm prior variables remain.
6. Restart.
7. Confirm the old variable is gone.
8. Force bridge failure.
9. Confirm all bridge and kernel processes terminate.

**Decision gate:** Determine whether the initial product may require
`jupyter_client` in the selected environment or whether app-owned bridge
packaging is required before release.

---

### Phase 1: Process and pure compute foundation

**Purpose:** Create stable contracts without server or Python coupling.

**Concrete changes:**

- Add `DuplexProcessPort` to `@scientfactory/execution`.
- Refactor shared process ownership (`LocalDuplexProcess`).
- Create `packages/scient-compute/` (`@scientfactory/compute`).
- Add session and execution state machines with legal-transition tables.
- Add generation checks.
- Add transport and language-adapter ports.
- Add initial output types (stream, diagnostic, image, system).
- Add framed protocol codec (encoder/decoder).
- Add deterministic simulator.
- Add fake second-language and non-Jupyter tests (the language-boundary test).

**Tests:**

- Every legal and illegal session and execution transition.
- Partial and combined protocol frames.
- Oversized and malformed frames.
- Fake non-Jupyter transport drives full session lifecycle.
- Fake second-language adapter drives the simulator without importing Python or
  claiming a real Jupyter cross-language launch proof.
- Cancellation and restart races against the simulator.

**Exit gate:** `@scientfactory/compute` imports no server, Python, Jupyter,
UI, or analysis code. The language-boundary test passes in CI.

---

### Phase 2: Python transport and runtime adapter

**Purpose:** Turn the spike into a supervised production boundary.

**Concrete changes:**

- Add `apps/server/src/scient/compute/bridge/scient_compute_bridge.py`.
- Add `BridgeProtocol.ts` (framed message codec and handshake).
- Add `JupyterBridgeTransport.ts` (implements `ComputeTransport`).
- Add `PythonRuntimeAdapter.ts` (discovery, verification, fingerprinting).
- Add `ComputeEnvironmentPolicy.ts` (environment sanitization).
- Add Python traceback normalization.
- Report bridge and kernel PIDs.
- Add real-kernel integration tests (skip when no interpreter present, following
  the MATLAB real-runtime test precedent).

**Tests:**

- Protocol golden fixtures for `execute_reply`, `display_data`, `error` with
  traceback, `status` busy/idle ordering.
- Malformed-frame and version-mismatch fail-closed.
- Oversized-line rejection.
- Real Python kernel: start, `1+1`, Matplotlib PNG, `KeyboardInterrupt` with
  namespace intact, restart, clean shutdown.
- Bridge crash → `dead`/`lost`.
- Process-tree death on cancel.

**Implementation gate:** On the primary development host, a real Python kernel
reliably executes, interrupts, restarts, emits PNG output, and terminates without
orphan processes, while every deterministic protocol/process boundary below is
green. Passing this gate permits Phase 3 implementation; it does not close
cross-platform qualification.

**Cross-platform qualification gate:** The same real-kernel lifecycle and
process-tree proof passes on macOS, Windows, and Linux before cross-platform or
release readiness is claimed.

#### Phase 2 implementation plan

This section is the implementation contract for Phase 2. It turns the
architectural direction above into reviewable work units. Phase 2 stops at the
transport and Python adapter boundary. It does not create sessions, persistence,
RPC, authorization, assets, or UI.

##### 2.1 Principles and proof boundary

The implementation follows these rules:

1. Use public `jupyter_client` APIs rather than implementing Jupyter or ZeroMQ
   in TypeScript.
2. Keep Jupyter and Python details inside the bridge, transport, and Python
   adapter. Do not add them to the coordinator-neutral package except where a
   real transport requirement exposes a missing neutral contract.
3. Prefer one supervised bridge process, one kernel, one framed pipe in each
   direction, and one event stream. Do not add a daemon, socket server,
   kernelspec registry, plugin framework, or general Python manager.
4. Decode and validate every external value once at its boundary. Internal code
   receives typed values, not unchecked dictionaries.
5. Bound every queue, frame, text value, traceback, image, diagnostic stream,
   deadline, and retained log.
6. Treat EOF, malformed messages, version mismatch, sequence mismatch, process
   exit, and kernel death as explicit failures. Never infer success from
   silence.
7. Prove cleanup with observed PIDs and process liveness. Never find or kill
   processes by executable name.
8. Require no modification of the selected Python environment. Verification is
   read-only and startup never installs packages.

The Phase 2 proof owns only this path:

```text
PythonRuntimeAdapter
  → ComputeEnvironmentPolicy
  → LocalDuplexProcess
  → scient_compute_bridge.py
  → jupyter_client
  → one ipykernel
  → typed ComputeTransportEvent stream
```

The deterministic simulator remains the coordinator test double. Tests above
this boundary must not need Python.

##### 2.2 Phase 1 amendments required before bridge work

Implementation begins with four narrow corrections exposed by the real
transport design:

- Add an explicit environment-inheritance policy to
  `DuplexProcessRequest`/`LocalOwnedProcess`. Compute launches must use a
  complete sanitized environment with `extendEnv: false`; existing one-shot
  callers retain their present behavior. Passing a sanitized record while the
  process layer silently re-adds the host environment is not sanitization.
- Add a transient binary-image transport event. `ComputeOutput.image` remains
  durable metadata, while the transport event carries its validated
  `Uint8Array` bytes alongside that metadata. Phase 3 consumes the bytes into
  compute-owned storage and persists only the metadata/reference. Do not put
  base64 or multi-megabyte byte arrays into durable snapshots.
- Change `ComputeLanguageAdapter.verify` to accept the same
  `ComputeLaunchRequest` as `prepareLaunch`, not only a runtime profile.
  Verification must exercise the selected executable with the caller-approved
  working directory and sanitized environment that launch will use.
- Add a bounded neutral `runtime-warning` system event. It represents
  nonfatal transport/runtime degradation, such as omitted mutable display
  behavior or inconsistent kernel metadata, without misclassifying it as
  Python user-code failure. Its existing bounded `detail` field must contain no
  submitted code, credentials, connection data, or environment values.

Name the transient image type independently (for example,
`ComputeTransportImageEvent`) rather than making bytes optional on every
persisted `ComputeOutput`. Add contract and simulator tests for all four
amendments before using them in the Jupyter transport.

No other Phase 1 contract changes are presumed. If implementation exposes
another mismatch, stop and amend the neutral contract with a focused test
instead of leaking a Jupyter special case into server orchestration.

##### 2.3 Concrete file layout

Add only:

```text
apps/server/src/scient/compute/
  BridgeProtocol.ts
  BridgeProtocol.test.ts
  ComputeEnvironmentPolicy.ts
  ComputeEnvironmentPolicy.test.ts
  JupyterBridgeTransport.ts
  JupyterBridgeTransport.test.ts
  PythonRuntimeAdapter.ts
  PythonRuntimeAdapter.test.ts
  PythonDiagnostic.ts
  PythonDiagnostic.test.ts
  bridge/
    scient_compute_bridge.py
    test_scient_compute_bridge.py
  fixtures/
    bridge/
      *.json
  PythonKernel.integration.test.ts
```

The Python sidecar is a single checked-in file and uses only the standard
library plus `jupyter_client`. Python tests use `unittest`; do not introduce a
Python project, package manager, lockfile, or pytest dependency for this phase.
TypeScript services follow existing server Effect `Context.Service`/`Layer`
patterns. Pure discovery, protocol, environment, and diagnostic helpers remain
plain functions where dependency injection adds no value.

Add `@scientfactory/compute` to the server workspace dependencies. Do not add
Node or Python dependencies to `@scientfactory/compute`.

##### 2.4 Protocol message schemas

`BridgeProtocol.ts` owns a closed union of per-message payload schemas on top
of the Phase 1 envelope and codec. Unknown message types or invalid payloads
fail the channel. Protocol v1 contains:

| Direction       | Type                 | Purpose                                                                                          |
| --------------- | -------------------- | ------------------------------------------------------------------------------------------------ |
| server → bridge | `hello`              | Negotiate version, limits, build, capabilities, and owner token.                                 |
| bridge → server | `hello-ack`          | Echo ownership and report bridge/platform capability.                                            |
| server → bridge | `start-kernel`       | Start exactly one kernel for the selected interpreter and working directory.                     |
| bridge → server | `kernel-ready`       | Report kernel PID, language identity, versions, and capabilities.                                |
| server → bridge | `execute`            | Submit code with stdin disabled and silent/store-history policy explicit.                        |
| bridge → server | `accepted`           | Confirm that an execute passed bridge validation.                                                |
| bridge → server | `stream`             | Emit bounded stdout/stderr text for an execution or session.                                     |
| bridge → server | `display`            | Emit one selected static PNG/SVG image or bounded text fallback.                                 |
| bridge → server | `error`              | Emit the raw bounded Python error report.                                                        |
| bridge → server | `warning`            | Emit a bounded nonfatal runtime warning or output-truncation notice.                             |
| bridge → server | `execution-complete` | Report the execute request outcome after reply-plus-idle correlation.                            |
| server → bridge | `interrupt`          | Interrupt the currently active kernel request.                                                   |
| bridge → server | `interrupt-result`   | Report whether the targeted execution was interrupted, already terminal, rejected, or timed out. |
| server → bridge | `restart`            | Replace the kernel with the exact requested next generation.                                     |
| bridge → server | `restarted`          | Report the replacement kernel PID and generation.                                                |
| server → bridge | `shutdown`           | Gracefully stop kernel and bridge.                                                               |
| bridge → server | `shutdown-complete`  | Confirm that the kernel is gone before clean bridge exit.                                        |
| bridge → server | `fatal`              | Report a bounded bridge/kernel failure before non-zero exit when possible.                       |

Rules:

- The server sends `hello` first. No kernel starts before a valid
  `hello`/`hello-ack` exchange.
- `hello` carries protocol version, server build identity, 16 MiB frame limit,
  required capabilities, and a cryptographically random 256-bit owner token.
  `hello-ack` must echo the token exactly. The token is process-local, never
  logged or persisted.
- Each direction owns an independent contiguous sequence starting at zero.
  Duplicate, missing, decreasing, or overflowing sequence values fail the
  transport. Pipes preserve order, so a gap is corruption, not a retry case.
- Every post-handshake message must match the opened `sessionId`. Generation
  must equal the live generation except that `restart` names both the current
  and exact next generation. A stale or skipped generation fails closed.
- Request IDs are non-null only for command-correlated messages. An
  `interrupt` uses the active execute request ID as its target, matching the
  neutral `ComputeInterruptRequest`; it does not allocate or publish a second
  request ID. Message type and state distinguish execute acceptance from an
  interrupt result.
- Each execute request is accepted at most once and reaches exactly one
  terminal `execution-complete` event unless the channel is lost. Unknown,
  duplicate, or terminal request IDs are protocol errors.
- `accepted` applies only to `execute`. The interrupt call waits for its
  bounded `interrupt-result`: `interrupted` means the signal was delivered and
  the execute still terminates only through `execution-complete`; `terminal`
  is the benign completion race; `rejected` or `timeout` fails the interrupt
  call with `ComputeTransportError`. A malformed or missing result fails the
  channel.
- A `warning` maps only to the neutral `output-truncated`,
  `input-unsupported`, or `runtime-warning` system event named by its decoded
  warning code. Unknown warning codes fail the closed protocol.
- JSON fields use explicit schemas and bounded lengths/counts. Booleans and
  nulls are not accepted as string substitutes.
- PNG bytes are base64 only on the bridge wire. The server checks encoded
  length before decoding, decodes once, verifies PNG signature and byte limit,
  computes SHA-256 itself, and emits transient bytes plus trusted metadata.
- SVG is bounded raw UTF-8 on the bridge wire. The server verifies an SVG
  document root, computes SHA-256 itself, persists it with an `.svg` identity,
  and serves it only through the existing sandboxed static-image asset path.
  Scient never treats a printed filesystem path as a display result.
- Diagnostic stderr is not protocol. Node drains it concurrently from spawn,
  retains only a bounded tail for failure context, redacts the owner token if
  encountered, and never forwards arbitrary stderr as user output.
- On protocol stdout EOF, Node calls decoder `finish()` before interpreting
  process exit. Partial data is truncation even if the process exit code is
  zero.

Keep golden JSON fixtures intentionally small. Generated image bytes belong in
test helpers, not large checked-in blobs.

##### 2.5 Handshake and startup state machine

`JupyterBridgeTransport.open` has one linear startup:

```text
spawned
  → streams-draining
  → hello-sent
  → hello-acknowledged
  → kernel-starting
  → kernel-ready
  → open
```

Any failure moves directly to `closing`, then `closed`. Startup uses one
deadline covering bridge import, handshake, kernel launch, and
`wait_for_ready`; the initial value is 30 seconds and is injectable in tests.
Timeout always cancels the owned process tree and waits for observed bridge
exit before returning.

The bridge reports its own PID in `hello-ack` and the kernel PID in
`kernel-ready`. Node verifies positive safe integers and rejects a bridge PID
that disagrees with the spawned handle. A missing kernel PID is a startup
failure for the local Python implementation because Phase 2 cleanup proof
depends on it.

The transport compares negotiated capabilities with
`requiredCapabilities` before returning the channel. Phase 2 requires
`execute`, `interrupt`, `restart`, and `shutdown`; unsupported optional
capabilities are not advertised.

Only one fiber reads protocol stdout and mutates protocol state. Command
writes are serialized by `LocalDuplexProcess`. Event publication uses both
count and aggregate-byte bounds; if a consumer cannot keep up, the transport
fails rather than buffering without limit or silently dropping output. Scope
finalization runs the same bounded shutdown path as explicit shutdown and is
idempotent.

##### 2.6 Python discovery and verification

Discovery is deterministic and deduplicates candidates by canonical executable
path:

1. Explicit configured executable.
2. Project `.venv` executable (`.venv/bin/python` or
   `.venv/Scripts/python.exe`).
3. `python3` then `python` on Unix `PATH`; `python.exe` then `python3.exe` on
   Windows `PATH`.

If an explicit path is configured, return its valid or invalid profile and do
not silently replace it with another interpreter. Without explicit
configuration, return every distinct viable project/PATH candidate in
precedence order. Phase 2 does not scan conda, pyenv, Homebrew, the Windows
registry, WSL distributions, or arbitrary conventional directories.

Do not pre-check and then execute candidates. Run one bounded standard-library
probe through the exact candidate and classify spawn errors directly, avoiding
a time-of-check/time-of-use race. The probe prints one JSON object containing:

- canonical `sys.executable`;
- Python implementation/version and architecture;
- `sys.prefix` and `sys.base_prefix`;
- platform;
- versions or absence of `jupyter_client`, `ipykernel`, `matplotlib`, `numpy`,
  and `pandas`.

Verification accepts a `ComputeLaunchRequest`, calls `prepareLaunch`, then runs
a bounded bridge self-check and starts a real kernel from that exact launch
plan. The transport independently calls `prepareLaunch` with the same request;
tests require equal executable, arguments, canonical working directory, and
sanitization result. Only explicitly session-owned temporary paths may differ
between the two plans. Readiness requires:

- CPython 3.10 or newer;
- installed `jupyter_client` 8.6 or newer;
- installed `ipykernel` 6.29 or newer;
- successful kernel startup and `kernel_info_request`;
- Python language identity returned by the kernel.

These minimums reflect APIs used by the bridge. Do not add an upper version
bound without evidence. A newer environment is accepted only after the
capability/startup probe succeeds. Missing modules, unsupported versions,
wrong architecture, timeout, malformed probe output, and startup failure map
to distinct actionable verification messages. Verification never runs
`pip`, writes into the environment, registers a kernelspec, or imports large
scientific packages merely to discover their versions.

The environment fingerprint includes the executable's canonical path and
modification time, Python implementation/version/architecture, prefixes and
platform, and the discovered versions or absence of required bridge/kernel
distributions. It is provenance, not a safe
verification-cache key: package contents can change without changing the
interpreter executable. Phase 3 reuses a probe for at most 30 seconds across
discovery, verification, and fingerprinting during startup; this is a startup
deduplication window, not a durable readiness cache.

##### 2.7 Launch and environment policy

The selected executable launches the checked-in bridge by absolute path:

```text
<selected-python> -I -u <absolute-bridge-path>
```

`-I` prevents project-controlled `PYTHONPATH`, user site packages, and current
directory imports from changing bridge code resolution. The selected
environment still supplies `jupyter_client`, `ipykernel`, and the kernel's
normal site packages. The bridge starts `sys.executable -m ipykernel_launcher`
directly through `jupyter_client`; it does not select a global kernelspec.

`ComputeEnvironmentPolicy` builds a complete environment and the process layer
uses `extendEnv: false`. It:

- preserves ordinary OS/runtime variables needed by Python, native numerical
  libraries, locale, temporary directories, GPU drivers, and user package
  configuration;
- removes all known Scient/T3 pairing, cloud, provider, updater, telemetry,
  signing, publication, and service credentials by exact key and owned prefix;
- removes `PYTHONPATH`, `PYTHONHOME`, `PYTHONSTARTUP`, `PYTHONINSPECT`,
  `JUPYTER_CONFIG_DIR`, `JUPYTER_PATH`, and IPython startup/profile overrides
  from the bridge environment;
- sets UTF-8/unbuffered behavior and an app-owned temporary connection-file
  directory;
- accepts only an absolute, canonical, caller-approved project root as `cwd`;
  authorization happens before the adapter, while this layer rejects
  malformed or noncanonical launch inputs;
- never logs values and exposes only removed key names in test diagnostics.

The exact denylist and prefix list are exported constants with table-driven
tests. This is credential-hygiene defense in depth, not a sandbox. User code
retains the filesystem, network, and process authority of the server account,
and can read credentials stored elsewhere under that account.

##### 2.8 Bridge concurrency and Jupyter correlation

The Python bridge uses one `asyncio` event loop and
`jupyter_client.AsyncKernelManager`/`AsyncKernelClient`. It has:

- one framed-stdin command reader;
- one serialized command dispatcher;
- one shell-channel reader;
- one IOPub-channel reader;
- one heartbeat/liveness task;
- one parent-connection watchdog;
- one bounded outbound writer queue and one stdout writer.

Only the stdout writer writes protocol bytes. Stderr receives bounded,
single-line bridge diagnostics with no environment values, HMAC keys,
connection-file contents, submitted code, or owner token.

One execute is active at a time. The bridge records the Jupyter message ID
returned by `execute` and maps it to the Scient execute request ID. For that
message ID it tracks:

- matching shell `execute_reply`;
- matching IOPub `status: busy`;
- matching IOPub `status: idle`;
- whether an interrupt was requested;
- whether an error was observed.

Completion requires the matching shell reply and matching idle after busy.
Shell and IOPub may arrive in either order. IOPub order is authoritative for
output: output observed before matching idle is emitted before completion.
Same-parent output received after completion remains correlated only while its
mapping is retained. Completed mappings are removed after 30 seconds or when
64 newer completed mappings exist, whichever comes first. Output arriving
later follows the unknown-parent rule and cannot reopen the execution.
Parentless output is emitted with null request ID. Messages for unknown parent
IDs are ignored only when they are documented kernel-global chatter;
otherwise they become bounded session-level `runtime-warning` events, never
output attributed to the active execution.

Map Jupyter messages as follows:

- `stream` → stream output after UTF-8/text and per-event bounds.
- `error` → one raw runtime error report; the TypeScript Python adapter
  normalizes it.
- `execute_result` and `display_data` → first valid `image/png`, otherwise
  bounded `text/plain`; ignore HTML, SVG, JavaScript, widgets, comms, and
  unknown MIME in Phase 2.
- `update_display_data` and `clear_output` → bounded `runtime-warning` events
  and safe fallback behavior only; mutable display semantics are deferred.
- `input_request` → immediately answer EOF/unsupported according to
  `jupyter_client` API and emit `input-unsupported`; never wait for a client.

Phase 4 extends the closed display mapping to validated `image/svg+xml` after
PNG and before the text fallback. HTML, JavaScript, widgets, comms, and mutable
display updates remain unsupported.

Execution outcome is `failed` when `execute_reply.status == "error"` or a
matching error is observed, `cancelled` when the active request reaches idle
after an acknowledged interrupt/`KeyboardInterrupt`, and `succeeded`
otherwise. Inconsistent reply/error states fail the execution conservatively
and emit a `runtime-warning`; they do not fail the session unless protocol
integrity or kernel liveness is lost.

##### 2.9 Interrupt, restart, shutdown, and loss

**Interrupt**

1. Return `interrupt-result: terminal` as a no-op if no execution is active,
   preserving the neutral completion-race behavior. Reject only when a
   different execution is active.
2. Call the kernel manager interrupt API for the matching active execution.
3. Emit `interrupt-result: interrupted` when the signal is delivered, or
   `terminal` if completion won the race. The bridge waits up to 2 seconds for
   busy and 2 seconds for settlement; the transport caps the whole response at
   10 seconds. Rejection or timeout fails the interrupt call without inventing
   a second request ID.
4. Continue correlating the active request's reply-plus-idle.
5. Complete the execute request as `cancelled` when interruption is observed.
6. If idle does not return within the bounded settlement window, report timeout
   and leave destructive restart to the caller; do not silently replace the
   namespace.

The integration proof sets a variable before an infinite loop and confirms it
still exists after `KeyboardInterrupt`.

**Restart**

1. Accept only `nextGeneration == currentGeneration + 1`.
2. Stop accepting execute/interrupt commands.
3. Terminate the old kernel through `restart_kernel(now=True)`.
4. After controlled old-kernel termination is confirmed, emit any active
   execute's terminal `execution-complete: cancelled`.
5. Recreate channels, wait for ready, obtain and report the new PID.
6. Clear all old parent/request mappings.
7. Emit `restarted` only after the replacement answers `kernel_info_request`.

If restart fails, terminate any replacement process and fail the channel. If
the old kernel dies before the transport can prove controlled replacement, the
active execution is lost with the channel rather than falsely cancelled.

**Shutdown**

1. Stop accepting commands.
2. Request kernel shutdown and wait up to 5 seconds.
3. Force-kill the kernel through the manager if still alive.
4. After controlled kernel termination is confirmed, emit any active
   execute's terminal `execution-complete: cancelled`.
5. Stop channels and remove connection files/directories.
6. Verify the recorded kernel PID is no longer alive.
7. Emit `shutdown-complete`, flush stdout, and exit zero.

Node waits for `shutdown-complete`, then closes the event stream and cancels the
owned process tree as an idempotent final cleanup. A missing acknowledgement or
failed bridge shutdown is loss, not clean completion.

**Loss**

Unexpected bridge exit, protocol failure, heartbeat failure, kernel death,
unrecoverable channel error, or command-write failure fails the event stream
exactly once with a bounded reason. The transport cancels the owned process
tree, waits for exit, closes the event queue, and preserves the first failure
as primary while logging later cleanup failures as causes.

Stdin EOF is the parent-death signal. The bridge watchdog performs the same
kernel cleanup as shutdown but cannot claim an orderly protocol exchange.
This covers normal parent exit and server crash without polling parent PIDs.

##### 2.10 Output and diagnostic limits

Phase 2 enforces limits before Phase 3 retention:

| Value                         |         Limit |
| ----------------------------- | ------------: |
| Submitted code                |   1 MiB UTF-8 |
| Wire frame                    |        16 MiB |
| Stream event                  | 256 KiB UTF-8 |
| Traceback lines               |           200 |
| Traceback line                |         4 KiB |
| Error name                    |     256 bytes |
| Error value                   |        16 KiB |
| PNG decoded bytes             |         8 MiB |
| SVG UTF-8 bytes               |         8 MiB |
| Bridge stderr retained tail   |        64 KiB |
| Transport event queue         |    256 events |
| Transport event queue payload |        32 MiB |
| Bridge outbound queue         |     64 frames |
| Bridge outbound queue payload |        24 MiB |

The 8 MiB binary limit base64-encodes below 11 MiB, leaving more than 5 MiB for
the JSON envelope and framing under the 16 MiB wire limit. Queue admission
accounts for encoded frame bytes on the bridge and decoded event payload bytes
in Node; count and byte capacity must both be available. Oversized text is
truncated on Unicode boundaries with an explicit `output-truncated` event. An
oversized image is dropped with the same event and bounded detail; it is never
partially decoded. Node, not Python, computes the trusted image hash. It
optionally reads PNG dimensions with a bounded, dependency-free header parser;
SVG dimensions remain null rather than trusting or evaluating arbitrary
document attributes.

Python traceback normalization strips ANSI/control sequences, bounds every
field, preserves the human-readable traceback, and extracts no filesystem
authority from traceback strings. Phase 2 does not attempt source mapping or
path authorization; Phase 3 can enrich frames against an authorized project.

##### 2.11 Test strategy

All mandatory unit tests run without Python:

- envelope payload schemas for every message type and direction;
- wrong version/session/generation/token/type/request/sequence;
- golden Jupyter-to-Scient fixtures for stream, result, PNG, SVG, error, busy/idle,
  parentless output, input request, and ignored MIME;
- shell-reply-before-idle and idle-before-shell-reply;
- duplicate/late/unknown parent messages and mapping expiry;
- count- and byte-bounded writer/event queues and slow-consumer failure;
- malformed, oversized, truncated, and valid-multi-frame protocol streams;
- stderr flood while stdout is active;
- configured/project/PATH discovery precedence and canonical deduplication;
- probe timeout, spawn failure, malformed output, versions, and missing
  requirements;
- exact environment removals, clean-environment spawn, and no value logging;
- Python diagnostic normalization and all limits;
- transport finalizer races across startup, execute, interrupt, restart,
  shutdown, and process exit.

The bridge's standard-library tests fake the kernel manager and channels to
cover command validation, correlation, queue bounds, cleanup ordering, and EOF
watchdog behavior. They must not require ZeroMQ or a kernel.

`PythonKernel.integration.test.ts` runs only when a dedicated interpreter is
supplied through `SCIENT_TEST_PYTHON` or when the repository's test bootstrap
has provisioned a known fixture environment. It must not opportunistically use
an arbitrary developer Python and then produce non-reproducible failures.
When enabled, it proves:

1. start and identity/PID reporting;
2. `1 + 1`;
3. `x = 41`, then `x + 1`;
4. stdout, stderr, exception, and traceback;
5. one Matplotlib PNG and one explicit SVG display with verified content/hash;
6. interrupt of an infinite loop with prior namespace intact;
7. restart with old namespace absent and a different live kernel PID;
8. bridge crash and kernel crash produce loss;
9. graceful shutdown removes bridge, kernel, and connection files;
10. forced cancellation leaves both recorded PIDs dead.

Cross-platform CI must provision this fixture on macOS, Windows, and Linux
before Phase 2 cross-platform qualification can pass. Local absence may skip
only the real-kernel suite with a visible reason; it may not skip protocol,
bridge-unit, or adapter tests.

##### 2.12 Implementation sequence and review gates

Land Phase 2 as one coherent branch, but implement and review in these
independently verifiable steps:

1. **Neutral amendments:** environment inheritance, transient image bytes,
   launch-context verification, and runtime warnings, with
   package/process/simulator tests.
2. **Protocol:** closed schemas, direction/state validation, golden fixtures,
   sequence and ownership checks.
3. **Environment and adapter:** bounded discovery/probe, verification,
   fingerprint, launch plan, sanitization, diagnostics.
4. **Bridge core:** framing, handshake, fake-manager unit tests, parent EOF,
   bounded writer, cleanup.
5. **Jupyter behavior:** execute correlation, output normalization, interrupt,
   restart, shutdown, heartbeat.
6. **Transport:** Effect scope ownership, immediate stream drains, event queue,
   command mapping, error and finalizer behavior.
7. **Real-kernel proof:** state, image, interrupt, restart, crashes, process
   liveness, and connection-file cleanup on the primary host for implementation;
   repeat on all three operating systems for cross-platform qualification.
8. **Boundary review:** dependency, seam, security, failure-semantics, and
   no-scope-creep audit.

Do not begin Phase 3 merely because the happy-path integration test passes.
The Phase 2 implementation candidate is complete only when:

- all protocol inputs are schema-decoded and state-validated;
- no user code runs before ownership/version/capability negotiation succeeds;
- every command and event queue has count and aggregate-byte bounds;
- both process streams drain from spawn and protocol EOF is finalized;
- selected-environment verification and launch use the same path;
- interrupt preserves state and restart clears it;
- clean shutdown and forced failure leave no recorded process alive;
- malformed input, bridge crash, and kernel crash produce one honest loss;
- no environment value, submitted code, HMAC key, connection file, or owner
  token appears in logs;
- `@scientfactory/compute` remains Python/Jupyter/Node/server independent;
- all new production files stay under the Scient-owned compute root, with only
  the package dependency and seam manifest as inherited integration changes;
- focused format, lint, package/server typecheck, unit, Python-unit,
  real-kernel, seam, and `git diff --check` validations pass.

Phase 3 implementation may proceed after this gate passes on the primary host,
while the qualification ledger continues to show unexecuted platforms as
pending. Packaging an app-owned Python runtime remains a separate decision. If
the selected-environment proof is not reliable enough for release, Phase 2
reports that evidence rather than quietly expanding into a Python distribution
project.

---

### Phase 3: Session service and durable record

**Purpose:** Create the server-owned stateful runtime.

**Concrete changes:**

- Add `computeDir` to `ServerConfig` and boot-time `makeDirectory`.
- Implement `ComputeSessionService.ts`.
- Implement bounded queueing (one active, 16 pending, FIFO).
- Implement generation semantics and stale-command rejection.
- Implement idle and running kernel liveness supervision, optional idle timer,
  and direct loss on failed liveness.
- Implement `LocalComputeStore.ts` (session.json, journal.ndjson, execution
  records, output.ndjson, outputs/).
- Persist requests, results, output, and static PNG/SVG files.
- Recover interrupted sessions as `lost` on next boot.
- Add `compute-output` asset resource and `AssetAccess` resolution.
- Add a metadata-preserving cleanup primitive and retention accounting. Defer
  the product retention policy and its service/RPC caller until that policy is
  accepted explicitly.
- Wire server layers in `server.ts`.

**Tests:**

- Interrupted writes and corrupted records.
- Hash mismatch rejection.
- Path traversal and symlink rejection.
- Server-restart recovery to `lost`.
- Output truncation markers.
- Metadata-preserving cleanup.

**Exit gate:** The server can lose or restart a kernel without losing
historical truth or leaving a false "running" state.

---

### Phase 4: First Python product slice

**Purpose:** Deliver the smallest coherent scientific capability.

**Concrete changes:**

- Add compute RPC contracts to `packages/contracts/src/` (new
  `scientCompute.ts` re-export, `rpc.ts` method registrations).
- Add read/operate authorization in `RpcAuthorization.ts`.
- Wire server handlers in `ws.ts` with `"rpc.aggregate": "compute"`.
- Add `packages/client-runtime/src/state/compute.ts`.
- Add the adapter-driven Scientific Computing settings page, initially with the
  Python adapter.
- Separate user-level language enablement and runtime defaults from the exact
  runtime selected and recorded for a project session.
- Show detected/configured runtime identity, readiness, missing requirements,
  and supported capabilities without installing or mutating the environment.
- Add project/session environment selection UI in
  `apps/web/src/scient/compute/`.
- Expose at most one live project session while retaining prior session
  lifetimes under fresh IDs; never overwrite or resume a terminal history.
- Add execution transcript, stdout/stderr, traceback, and static PNG/SVG rendering.
- Add a Python file surface with Code/Split/Results modes, contextual run
  selection/cell/file actions, an immediately visible selected-run result,
  compact source context, compact run history, and persisted side-by-side or
  stacked Split presentation. Do not duplicate submitted code or storage
  identifiers in the result surface.
- Add optional, bounded live-variable inspection as a secondary Results view:
  refresh after terminal executions (including failures), clear on restart,
  never persist the snapshot, and never attribute it to historical sessions.
- Keep the project Compute surface as secondary session/history navigation and
  omit a generic Phase 4 code composer.
- Configure the Python kernel's Matplotlib integration so ordinary displayed
  figures are emitted as Jupyter image output and render inline before opening
  in the existing full image viewer. Also retain supported PNG/SVG project files
  created or changed during an execution through the shared project-output
  observer. Printing a path alone is never interpreted as a figure, and the
  Python/Jupyter transport never scans the project filesystem.
- Add interrupt, restart, and stop controls.
- Record saved-versus-dirty source truth and the exact submitted code/hash.
- Keep source, transcript, figures, and generated project files connected to the
  ordinary editor, workspace tree, and typed viewers.
- Let a current, stably identified figure move between the ordinary full viewer
  and the shared floating image card and follow later successful revisions.
  Historical and unstable-source figures remain snapshots; closing the viewer
  ends following.
- Update `scient-analysis-seams.json` with new owned roots and diff signals.
- Update release-smoke inventory.
- Add user and internal documentation.

**Tests:**

- Transcript folding of snapshot + delta + out-of-order chunks.
- Bounded retention.
- Stale-generation rejection.
- Settings: disabling Python stops offering it for a new session but preserves
  history; enabling it performs discovery only; choosing a default does not
  change an existing session's recorded runtime.
- The settings renderer consumes the adapter registry/capability model without
  a Python-only branch in the shared settings domain.
- End-to-end: select Python, start session, run two state-dependent
  executions, inspect bounded live variables after success and failure, view a
  figure, interrupt, restart, confirm the namespace view clears, and review
  history after app restart.
- Workspace lifecycle: computation modifies a clean open file, conflicts with a
  dirty buffer, and creates a new project file without a hidden compute copy.

**Product exit gate:** A scientist can:

1. Open Scientific Computing settings, enable Python, and understand whether an
   exact runtime is ready or what requirement is missing.
2. Select Python and an exact project runtime.
3. Start a project session.
4. Execute dependent pieces of code.
5. Inspect text and a figure.
6. Inspect a bounded current-variable summary without confusing it with run
   history.
7. Interrupt a long operation.
8. Restart the namespace and see the live variable view clear.
9. Review the prior history after restarting Scient.
10. Return from an execution to its ordinary source editor and open its figure
    through the existing preview surface.
11. Observe computation-created project files through the normal workspace
    lifecycle.

### Post-baseline capability roadmap

Phases 0-4 are the required foundation sequence. The work below is organized as
first-class capability tracks rather than Phase 4.1 through Phase 8. The tracks
are substantial and may proceed in parallel when their dependencies are met;
their ordering below is not a statement of product importance. Each accepted
slice receives a disposable implementation plan, focused acceptance evidence,
and any lasting decision is reconciled into this ADR before that plan is
deleted.

#### Track A: Runtime acquisition and environment management

**Purpose:** Make scientific computing usable without requiring every scientist
to provision bridge requirements manually, while preserving independently
optional runtimes, packages, and licenses.

Separate and decide explicitly:

1. User-selected external runtimes, which Scient verifies but never mutates
   implicitly.
2. An optional app-owned transport host, if packaging and support evidence show
   that one is required.
3. An optional Scient-managed environment for one language, beginning with
   Python only when its version, package baseline, update policy, package
   installation policy, storage location, and ownership are accepted.

The Scientific Computing settings page is the shared control surface for
language-scoped acquire, verify, update, repair, disk-usage, and remove actions.
Acquisition is explicit and removable. Installing Python must not install R,
Julia, MATLAB, their transports, or proprietary licenses, and adding a language
must not enlarge the base application for users who did not choose it.

**Exit gate:** A user with no ready Python runtime can deliberately obtain or
select one, understand its ownership and disk cost, repair or remove a
Scient-managed installation, and run the product loop without Scient mutating
an unrelated environment.

#### Track B: Rich and interactive scientific representations

**Purpose:** Make the Results surface a complete scientific viewing environment,
not a static-image exception.

Build the neutral representation bundle and renderer registry described in
Section 10.2, then add important formats in independently testable slices:

1. Markdown, LaTeX, PDF, validated static image formats, and structured JSON.
2. Plotly, Vega, and Vega-Lite with bounded schema validation and the existing
   Scient-owned renderer seams where applicable.
3. Safe HTML documents and fragments with explicit inert/sanitized and
   sandboxed-active modes; active HTML never shares the Scient origin or host
   authority.
4. Supported audio/video representations through ordinary typed viewers.
5. Display updates and clear-output semantics without rewriting immutable
   historical executions.
6. Stateful widgets/comms and interactive input only after their lifecycle,
   authority, timeout, disconnect, and history semantics are accepted.

Every renderer must define size bounds, validation, fallback, persistence,
copy/download/open behavior, remote delivery, and failure presentation. A
renderer failure cannot corrupt the execution record or blank other supported
representations from the same result.

**Exit gate:** Important outputs produced by supported adapters render at the
highest safe fidelity available, fall back truthfully, reopen from durable
history, work over authenticated remote connections, and cannot obtain ambient
application authority through their content.

#### Track C: Native notebook documents

**Purpose:** Support notebooks as first-class, ordinary project files while
reusing the same compute sessions, execution records, renderers, provenance,
and runtime settings as source-file execution.

The initial notebook format is `.ipynb`, but the architecture is a notebook
document capability rather than a Jupyter Server dependency. The implementation
must define:

- lossless round-trip of cell IDs, order, source, supported metadata, and
  unknown metadata that Scient does not understand;
- code, Markdown, and raw cells, with clear selection and editing behavior;
- run cell, run all, run above/below, interrupt, restart, clear output, and
  kernel/runtime selection through the existing compute service;
- the exact relationship between immutable compute history and output snapshots
  saved in the notebook document;
- dirty-buffer, external-edit, merge/conflict, autosave, and crash-recovery
  semantics using the ordinary workspace authority model;
- notebook trust, HTML/widget authority, attachments, large-output bounds, and
  remote behavior; and
- agent-readable project files without a hidden notebook database or a second
  private execution history.

`# %%` source cells remain useful for ordinary scripts; they are not a
substitute for native notebook documents. Notebook support must reuse
`ComputeSession` rather than introducing a second kernel/session coordinator.

**Exit gate:** A scientist can open, edit, execute, save, close, reopen, diff,
and share a real notebook without losing unsupported metadata, confusing saved
document output with live namespace state, or bypassing compute provenance and
security boundaries.

#### Track D: Structured scientific data and language intelligence

**Purpose:** Make live scientific state inspectable without turning the UI into
an unbounded object browser.

Add incrementally:

- bounded NumPy array inspection and slicing;
- pandas, Polars, and language-neutral tabular previews;
- explicit drill-down and export contracts for large values;
- completion, signature help, documentation, and richer language inspection;
- variable editing only if a later proposal can make mutation explicit,
  attributable, reversible where possible, and truthful in execution history;
  and
- multiple visible sessions only after product workflows justify the added
  session-selection and resource complexity.

**Exit gate:** Large values remain bounded and responsive, inspection does not
silently execute arbitrary user code, and any namespace mutation is represented
as an explicit compute operation rather than hidden UI state.

#### Track E: Portable project results

**Purpose:** Let a scientist deliberately turn retained operational output into
a durable, shareable project result without making private session history a
second project filesystem.

Implement:

- explicit promotion of a terminal retained execution into a deterministic
  project `results/` destination;
- atomic staging and rename, content-hash verification, collision and symlink
  refusal, idempotent retry, and redaction of machine-local details;
- a compute-specific publication service and receipt that reuse established
  runtime-neutral semantics without importing `AnalysisService`, disguising an
  execution as `AnalysisRun`, or prematurely creating a universal artifact
  package; and
- session generation and prior-execution lineage sufficient to state honestly
  when the promoted result depended on earlier in-memory state.

**Exit gate:** A promoted result is ordinary project material, opens through
existing viewers, preserves provenance, and never claims standalone
reproducibility when its inputs included unrecorded session state.

#### Track F: Reliability, scale, and release qualification

**Purpose:** Qualify retained, remote, multi-client, and packaged use without
pre-building infrastructure that measurements do not justify.

Gap-detecting recovery, bounded live delivery, output-flood protection, crash
and restart races, durable rehydration, and process-tree cleanup are already
part of the Phase 1-4 baseline and remain regression gates. Add only when
evidence requires it:

- a rebuildable SQLite session/execution projection and keyset pagination;
- bounded multi-client attachment and reconnect behavior;
- accepted idle-retention and cleanup policy;
- bridge/kernel resource telemetry and diagnosed stale-process cleanup using
  PID, start time, and an owner token;
- corruption isolation, long-running soak, startup-storm, and memory-growth
  qualification; and
- hosted real-kernel and packaged-app acceptance on supported macOS, Windows,
  and Linux targets, current-main integration, required checks, and explicit
  release approval.

**Exit gate:** Representative long histories and multiple clients remain
bounded and responsive; faults and shutdowns do not create orphan processes,
corrupt history, or lying UI state; and every claimed release platform has
hosted and packaged evidence tied to the exact candidate.

#### Track G: Additional languages

**Purpose:** Deliver a genuinely polyglot scientific product and validate that
the shared architecture remains independent from Python and Jupyter.

A second production adapter should arrive early enough to test the shared
contracts before they ossify. Adapter selection follows scientist workflows,
runtime availability, licensing, packaging, and transport evidence rather than
the numbering of this document. Every adapter has a capability/parity matrix
covering discovery, optional acquisition, exact runtime selection, source/cell
semantics, sessions, diagnostics, variables, tables, figures and rich
representations, interrupt/restart/stop, history, and remote use. Honest
capability differences are allowed; parallel product systems are not.

Initial candidates:

- **R:** Evaluate IRkernel and other measured transports; implement R
  discovery, verification, diagnostics, source/cell semantics, variables, and
  exact selected-kernel launch independent from any Python runtime.
- **Julia:** Evaluate IJulia and native alternatives with the same
  exact-runtime, representation, and optional-acquisition rules.
- **MATLAB:** Evaluate MathWorks-supported Jupyter integration, MATLAB Engine,
  and the existing isolated analysis adapter. Preserve `AnalysisRun` for fresh
  isolated work while a stateful MATLAB adapter converges on the shared compute
  experience.

The compute coordinator must not require language-specific modification merely
to support a different adapter or transport. Every language is independently
optional, registers with the same Scientific Computing settings model, and does
not make its runtime, packages, transport host, or license a prerequisite for
Scient or another language.

**Exit gate:** A real non-Python adapter passes the shared conformance suite and
delivers an honest end-to-end workflow without Python-specific changes to the
compute domain, persistence, authorization, history, or shared Results UI.

#### Track H: Operation envelope and agents

**Purpose:** Allow agents to use compute sessions without weakening authority
or provenance.

Implement:

- a host-derived operation envelope;
- actor identity, project scope, capabilities, authority generation, and
  operation lineage;
- receipt binding to operation IDs;
- provider-owned sessions and cross-provider isolation;
- MCP read and execute capabilities with structured execution results;
- the same project compute history, source associations, viewers, notebook and
  result-publication paths used by manual executions; and
- user-visible attribution and authorized interrupt, restart, and stop control.

**Exit gate:** No provider can inspect or operate another provider's session,
agents cannot attach to user sessions without an explicit grant, and no agent
execution or result exists only in provider-private scientific history.

A narrow, feature-gated pilot may begin after Phase 4 product acceptance, the
baseline gap-recovery/output-bound/process-cleanup guarantees, and acceptance of
the operation envelope. It need not wait for notebooks, every renderer, or every
language, but later capabilities must use the same actor and provenance model.

### Roadmap dependency gates

The capability tracks are not a license to build everything concurrently or to
hide priorities. Choose one bounded product slice at a time while maintaining
continuous reliability and mainline-integration evidence:

- runtime acquisition, the neutral representation bundle, and a
  second-language transport spike may begin from the accepted Phase 4
  foundation;
- native notebook implementation begins only after its document/output/trust
  contract is accepted, but it does not wait for every future renderer;
- Plotly/Vega and safe HTML require the representation bundle, while widgets
  additionally require the comm lifecycle and isolated-authority model;
- each managed language runtime requires its own acquisition decision and does
  not inherit approval from Python;
- portable result promotion can proceed independently once its publication and
  lineage contract is accepted;
- the agent pilot requires the operation envelope and baseline reliability
  guarantees, but not complete notebook, renderer, or language parity; and
- release approval always requires exact-current-main, hosted, packaged, and
  platform evidence regardless of how many product tracks are implemented.

The current planning recommendation after closing the Phase 4 candidate is to
investigate runtime acquisition and the neutral rich-representation contract
first, then choose the first implementation slice from measured user value.
Native notebooks and a real second-language adapter should receive early
architecture spikes in parallel so Python/file-view assumptions cannot harden
into permanent shared contracts.

---

## 21. Extraction Gates

Do not create broad shared abstractions merely because they look likely.

### Artifact extraction gate

Create a shared artifact package (`@scientfactory/artifacts`) only after
analysis and compute demonstrate stable common behavior in representation
identity, media validation, content hashing, publication, resolution, and
cleanup.

### Execution coordinator gate

Extract shared orchestration from `AnalysisService` and
`ComputeSessionService` only after concrete duplication exists. Likely
candidates: bounded journals, output accumulation, atomic publication,
retention accounting, process ownership.

Do not unify analysis receipts, compute execution receipts, document-build
receipts, or session and terminal-run lifecycles.

### Managed runtime gate

Separate three decisions:

1. User-selected external runtime for one language (Python first).
2. Optional app-owned transport host, such as the Jupyter bridge runtime
   (separate proposal after measured packaging/support evidence).
3. Optional managed scientific environment for one language (separate proposal
   covering runtime version, package baseline, upgrades, disk usage, removal,
   and package installation policy).

Evidence for one does not automatically approve the others, and approval for
one language does not add its runtime or license to every Scient installation.

---

## 22. Seam Manifest Updates

Update `scient-analysis-seams.json` (or a successor `scient-compute-seams.json`)
with:

**Owned roots:**

- `apps/server/src/scient/compute`
- `apps/web/src/scient/compute`
- `packages/scient-compute`

**Owned files:**

- `packages/contracts/src/scientCompute.ts`
- `packages/client-runtime/src/state/compute.ts`
- Migration files for compute session/execution indexes (when added)

**Diff signals:**

- `@scientfactory/compute`
- `compute-output`
- `ComputeSession`
- `ComputeExecution`
- `scientCompute`
- `SCIENT_COMPUTE_`

**Upstream mounts:**

- `apps/server/src/config.ts` — `computeDir` derivation.
- `apps/server/src/server.ts` — `ComputeSessionService` layer wiring.
- `apps/server/src/ws.ts` — compute RPC handler mounting.
- `apps/server/src/auth/RpcAuthorization.ts` — compute scope assignment.
- `packages/contracts/src/rpc.ts` — compute method registration.
- `packages/contracts/src/assets.ts` — `compute-output` resource kind.
- `apps/server/src/assets/AssetAccess.ts` — compute-output resolution.
- `packages/contracts/src/index.ts` — `scientCompute.ts` export.
- `packages/client-runtime/src/rpc/client.ts` — compute subscription
  registration.

---

## 23. Verification Contract

The focused suite covers:

- Legal and illegal session and execution state transitions.
- Compute-neutral transport and language-adapter simulators, plus a
  fake non-Python language-boundary consumer.
- Python explicit/PATH/missing discovery, version parsing, `ipykernel`
  availability checking, and actionable failure classification.
- Real Python kernel startup, stateful execution, Matplotlib PNG capture,
  interrupt with namespace intact, restart with namespace cleared, and clean
  shutdown.
- Real host cancellation of bridge and kernel process trees.
- Framed protocol codec: golden fixtures, partial frames, oversized frames,
  malformed frames, version mismatch.
- Completion correlation: reply + idle, reply before idle, parentless output,
  late output, kernel death during execution.
- Persistence: interrupted writes, corrupted records, hash mismatch, path
  traversal, server-restart recovery to `lost`.
- Bounded snapshot-plus-notification delivery, duplicate suppression, sequence
  gap detection, frozen uncertain deltas, and durable client rehydration.
- Execution-scoped project-image observation: new and changed PNG/SVG files,
  immutable retained bytes, path/content-hash provenance, symlink refusal,
  hidden/dependency-directory exclusion, per-file and per-execution bounds, and
  fail-closed behavior when a complete project inventory cannot be observed.
- Seams: `pnpm analysis:seams:check` extended to compute roots.

### 23.1 Qualification ledger

Keep evidence here, or in a later dedicated qualification record, rather than
encoding it into the architecture status.

| Gate                                           | Current evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                        |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Architecture                                   | Product principles and domain/dependency boundaries accepted by the owner                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Accepted                                      |
| Phase 1-3 implementation baseline              | Rebased feature-branch commit `86800197be`; focused compute/server/Python suites, real Python kernel, typechecks, format/lint, seam check, and production server build passed during foundation qualification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Locally qualified on macOS                    |
| Phase 4 implementation candidate               | Commit `c6a2f2eb75` contains Scientific Computing settings, RPC/authorization, server-derived project identity, saved-source validation, bounded client folding/gap recovery, Code/Split/Results with explicit caret-aware `# %%` cells, focused run history, bounded transient live variables, inline signed PNG/SVG viewing, secondary project history, and workspace refresh                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Committed locally                             |
| Combined backend and client qualification      | On the rebased candidate through `fba89323a9`, 100 compute, 310 contracts, 639 client-runtime, 178 changed-surface web, 425 affected server, and 83 bridge tests pass. Eight explicitly gated real-kernel/product tests cover state and safe variables after success/failure/restart, ordinary `plt.show()` PNG, explicit SVG display, interruption, restart, loss, output flood, rapid execution, restart storms, durable history, bounded generated-project-image capture, and immutable retained bytes. All affected typechecks, format/lint, seam and brand checks pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Passed on macOS                               |
| Phase 4 visual product acceptance              | The owner rejected the initial composer/history-first surface, then manually tested and accepted the replacement file-first Code/Split/Results workflow. The owner subsequently tested and accepted figure following, floating presentation, direct figure actions, and side-by-side/stacked layouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Accepted locally                              |
| Stable rebased candidate                       | Commit `c6a2f2eb75` is the Phase 4 checkpoint. The complete source candidate through `fba89323a9` contains `origin/main` snapshot `e207eefe831e` in its ancestry. Current-main integration is proven for that snapshot; later-main integration remains a moving release gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Stable local checkpoint                       |
| Post-Phase 4 UI extension candidate            | Figure-follow and interaction hardening through `ac91d23eaa` provide stable project-file and saved full-file runtime references, immutable historical snapshots, explicit full and floating presentation destinations, passive no-resurrection updates, deterministic cross-session revision ordering, gap recovery, same-content zoom continuity, decode-before-swap image transitions, and bounded keyboard move/resize/Escape controls. Commit `ac22fa3e5e` adds producer-neutral static-image actions, `338d246b3a` adds persisted side-by-side/stacked Results layouts through a shared axis-neutral split hook, and `4d621b767c` exposes direct open, float, copy, and download actions consistently across result, viewer, and floating surfaces. Commit `fba89323a9` keeps the implementation in the generic preview layer while restoring the inherited viewer's existing compatibility seam; exact-diff seam checks, 14 focused image tests, and web typecheck pass after that correction. Production web and desktop/server builds, exact bridge staging, release smoke, and Electron smoke pass on the combined rebased candidate. | Locally qualified and owner-accepted on macOS |
| Phase 2 real-kernel portability                | ADR requires macOS, Windows, and Linux; hosted macOS/Linux and Windows evidence is not yet complete                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Pending                                       |
| Packaged cross-platform and release acceptance | Local production web and desktop/server builds, exact bridge staging, release smoke, and Electron smoke pass; the release-qualification track's installed-app tests on supported platforms, future-main integration, hosted required checks, and explicit release approval remain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Pending                                       |

Local test counts are evidence for one exact snapshot, not a substitute for a
gate above. Phase 2 real-kernel portability and packaged-app release acceptance
remain distinct claims.

---

## 24. Accepted Recommendation

Implement and qualify the following architectural direction:

1. `ComputeSession` as a separate stateful scientific domain, not an analysis
   mode.
2. One project-centered scientific experience: ordinary source files and
   editors, one compute history, existing typed viewers, and explicit portable
   project results.
3. Stateful session execution and isolated analysis execution as complementary,
   visibly distinct actions.
4. A polyglot core with independently optional language runtimes, transport
   dependencies, managed downloads, and proprietary licenses.
5. Python first; Jupyter through a framed bridge for compatible kernels, not
   Node-native ZMQ and not as a universal language requirement.
6. Duplex process supervision as a shared execution foundation.
7. Honest generation, interrupt, restart, loss, exact submitted-code, and
   saved-versus-dirty source semantics.
8. Project files as durable source truth; `computeDir` as operational history,
   never a second project filesystem.
9. Compute-owned initial outputs and explicit provenance-preserving promotion,
   without premature shared artifact migration.
10. At most one live project session in the first UI, with a fresh durable ID
    for each lifetime and inspectable prior histories.
11. Human and later agent operations in the same scientific system and review
    surface, with actor-specific authorization and ownership.
12. No agent execution before the operation envelope and minimum reliability
    gates.
13. Native notebooks are ordinary project documents that reuse the same
    compute sessions, provenance, representations, and workspace authority;
    they do not create a second kernel coordinator or hidden source database.
14. Rich output is a language-neutral representation platform covering
    important static, document, structured-data, interactive, HTML, media, and
    later widget formats, each with explicit validation and authority.
15. No managed runtime or shared artifact migration without separate evidence
    and explicit user choice.
16. Prove the foundation with Python, then validate transport-host/kernel
    separation and shared Results behavior with a real second-language adapter.
17. Extract broader shared abstractions only after real duplication is
    demonstrated.

Complete the smallest human vertical slice (Phases 0–4) before expanding the
product surface. After that, treat runtime acquisition, rich representations,
native notebooks, structured scientific data, portable results, reliability,
additional languages, and the agent pilot as first-class capability tracks.
Advance them by their dependency and acceptance gates rather than pretending
the roadmap is one serial queue or treating the later-numbered work as less
important.

This plan keeps the long-term foundation scalable while ensuring the first
investment produces immediate scientific value rather than a large collection
of infrastructure with no finished user loop.
