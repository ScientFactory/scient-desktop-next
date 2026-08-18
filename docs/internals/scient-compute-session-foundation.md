# Stateful Scientific Compute Foundation

Status: Proposed (not yet accepted)
Owner: Yaacov
Created: 2026-08-18
Purpose: Defines the architecture, domain model, transport boundary, persistence semantics, and phased implementation plan for stateful interactive scientific compute sessions in Scient. Written as a companion to the accepted `scient-analysis-runtime-foundation.md`, which governs one-shot terminal execution.
Doc type: Architecture decision record (proposed)

## Document Rules

This document proposes a new stateful compute subsystem. It does **not**
replace the analysis runtime foundation, select a Python distribution, define a
final persisted schema, authorize a T3 divergence, or claim that anything
described here is implemented.

Its status is **Proposed (not yet accepted)**. Nothing here is product truth
until a human review accepts it.

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
model, or phase boundaries materially change. Move accepted architecture into
`docs/architecture/` and shipped behavior into user-facing docs rather than
treating this proposal as either.

---

## 1. First-Principles Objective

The goal is not to build a notebook platform, package manager, artifact
database, or new agent runtime.

The first goal is one dependable scientific loop:

1. Select a Python environment.
2. Start a persistent Python process.
3. Execute code repeatedly while variables remain available.
4. See text, errors, and figures.
5. Interrupt code without losing prior state.
6. Restart intentionally when a clean namespace is needed.
7. Preserve an honest execution record.
8. Never leave orphan processes or claim that lost memory survived.

Everything else — rich MIME, variables, agents, additional languages, managed
environments — builds on that loop incrementally.

---

## 2. Preserve Existing Execution Concepts

Scient already has two distinct execution systems. This proposal adds a third.

| System | Purpose | Lifecycle |
|---|---|---|
| `AnalysisRun` | Isolated, terminal file/task execution | One process, one exit code, one terminal result |
| `DocumentBuild` | Revision-bound LaTeX/document production | Build → publish → binding lifecycle |
| `ComputeSession` (proposed) | Long-lived interactive namespace | Many executions, persistent variables, interrupt/restart |

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
*"When the second real consumer exposes genuinely shared server orchestration,
lift that behavior into an `ExecutionCoordinator`; do not make `DocumentBuild`
depend on `AnalysisService`, and do not force either specialized receipt into
a generic task record."* This proposal follows that guidance: `ComputeSession`
is a sibling specialization, not a mode inside `AnalysisRun`.

---

## 3. Initial Product Slice

### Build now

- Explicit Python executable selection and verification.
- One default stateful session per project.
- Run selection, cell, file, or console code.
- Persistent variables between executions.
- Standard output and standard error.
- Structured Python tracebacks.
- Matplotlib/seaborn PNG figures.
- FIFO execution ordering.
- Cancel queued execution.
- Interrupt active execution.
- Restart and clear the namespace.
- Stop the session.
- Durable local execution history.
- Historical transcript after app restart or kernel failure.
- Reliable process-tree cleanup.
- Authenticated remote operation through existing operate scopes.

### Defer

- Managed Python installation.
- Agent execution (requires operation envelope).
- Variable explorer.
- Plotly or Vega-Lite kernel output.
- Arbitrary HTML.
- Notebook editing.
- Widgets and comms.
- Interactive stdin.
- Full mobile UI.
- Multiple user-visible sessions per project.
- R, Julia, or MATLAB sessions.
- Cross-domain artifact refactoring.

The underlying identifiers and contracts support these additions without
requiring a redesign.

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

The first UI exposes one default session per project. The model uses a real
session ID so additional sessions can be added later without migration.

### 4.2 Session generation

Generation starts at 1 and increases after every restart.

Every mutating request carries `sessionId` and `expectedGeneration`. This
prevents a stale browser or delayed request from executing code in a newly
restarted namespace.

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
- A delayed heartbeat makes it unresponsive without immediately declaring it
  lost.
- A failed execution does not mean the session failed.

### 4.5 Compute execution

A `ComputeExecution` records:

- `executionId`
- `sessionId` and session generation
- Exact submitted code and SHA-256 content hash
- Source origin (file, selection, cell, console)
- File revision and source range where available
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
  ComputeSessionIndex.ts         — rebuildable SQLite projection (added in Phase 5)
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
  readonly closeInput: Effect<void>;
  readonly exitCode: Effect<number>;
  readonly cancelProcessTree: Effect<void>;
}
```

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
- Enforces protocol frame-size limits before sending data to Node.
- Removes connection files during shutdown.
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

---

## 9. Transport and Language Adapter Ports

### 9.1 Compute transport

```ts
interface ComputeTransport {
  open(
    request: TransportOpenRequest,
  ): Effect<ComputeChannel, ComputeTransportError, Scope>;
}

interface ComputeChannel {
  readonly events: Stream<TransportEvent>;
  execute(request: ExecuteRequest): Effect<void>;
  interrupt(): Effect<void>;
  restart(): Effect<void>;
  shutdown(): Effect<void>;
}
```

Completion and inspection are optional capabilities represented in the
transport contract and added when needed.

### 9.2 Language adapter

```ts
interface ComputeLanguageAdapter {
  readonly languageId: string;
  readonly transportKind: string;

  discover(...): Effect<ReadonlyArray<RuntimeProfile>>;
  verify(...): Effect<RuntimeVerification>;
  prepareLaunch(...): Effect<TransportOpenRequest>;
  normalizeDiagnostic(...): ReadonlyArray<ComputeDiagnostic>;
  fingerprintEnvironment(...): Effect<EnvironmentFingerprint>;
}
```

Later variable inspection belongs here as a capability.

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

This proves the coordinator contracts are not Python-specific. A real R
installation is not required to deliver Python. Real R becomes a later
integration proof.

### 9.6 Jupyter does not eliminate language adapters

Jupyter eliminates repeated transport work for Python, R, and Julia. It does
not eliminate runtime discovery, environment selection, startup
configuration, capability negotiation, working-directory behavior, diagnostic
normalization, variable inspection, or language-specific bootstrap behavior.

The correct exit gate for adding R is:

> R reuses the coordinator, persistence, output pipeline, and Jupyter
> transport, implementing only an R language adapter.

Not:

> R is only a kernelspec name and snippet.

---

## 10. Output Model

### 10.1 Initial output types

The first product slice supports:

```ts
type ComputeOutput =
  | StreamOutput    // stdout/stderr text
  | DiagnosticOutput // exception type, message, traceback frames
  | ImageOutput     // PNG figure with content hash and signed resource
  | SystemOutput;   // session started, interrupted, restarted, lost, truncated
```

### 10.2 Reserved future output types

The contract permits later additions for:

- MIME bundles (display_data with multiple representations).
- Display updates (update_display_data with display_id).
- Clear output (clear_output, including delayed clear).
- Markdown, LaTeX, SVG, HTML.
- Plotly JSON, Vega-Lite JSON.
- Tables and structured JSON.
- Input requests (stdin).

The first implementation normalizes Jupyter messages correctly even when the
UI does not render every MIME type. Unsupported representations are ignored or
surfaced through a safe `text/plain` fallback.

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
Instead, define a compute-owned representation contract for PNG output:
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
  _tag: "compute-output",
  projectId,
  sessionId,
  executionId,
  outputId
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

The UI exposes one default Python session for each project. Internally:

- The session has a real ID.
- APIs accept session IDs.
- Storage is session-scoped.
- Nothing assumes the project can never have another session.

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
2. Increment the generation.
3. Cancel queued work.
4. Mark active work `cancelled` or `lost` according to observed transport
   state.
5. Restart the kernel.
6. Emit a visible namespace-cleared marker.
7. Return the session to `ready`/`idle`.

### 12.6 Shutdown

1. Reject new work.
2. Cancel queued executions.
3. Request graceful kernel shutdown.
4. Wait for a bounded deadline (5 seconds).
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
- PNG metadata and content hash.
- Terminal execution state.
- Explicit truncation markers.

### 13.3 What is not persisted

- Arbitrary Python namespace objects.
- Jupyter HMAC keys or connection files.
- Environment-variable contents.
- Credentials.
- Claims that a kernel can be resumed after process loss.
- Hidden variable-inspection code (added later).

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
- `compute.configureRuntime`
- `compute.verifyRuntime`

Session:

- `compute.openSession`
- `compute.getSession`
- `compute.restartSession`
- `compute.shutdownSession`

Execution:

- `compute.execute`
- `compute.cancelQueuedExecution`
- `compute.interruptExecution`
- `compute.listExecutions`
- `compute.getExecution`

Subscription:

- `compute.subscribeSession`

### 14.2 Authorization

Follow the existing `RpcAuthorization.ts` pattern:

Read scope (`AuthOrchestrationReadScope`):

- Runtime status.
- Session status.
- Historical executions and output.

Operate scope (`AuthOrchestrationOperateScope`):

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
- Interrupt button while busy.
- Restart action with namespace-loss confirmation.
- Stop action.
- Execution transcript.
- stdout/stderr rendering.
- Structured traceback rendering.
- Matplotlib image output.
- Visible restart, interruption, loss, and truncation markers.

### 15.3 Editor actions

- Run selection in Python session.
- Run current cell in Python session.
- Run file in Python session.
- Run file isolated through the existing analysis system.

The UI should explain the difference:

- **Run in session:** fast and stateful, uses existing variables.
- **Run isolated:** fresh process, more reproducible.

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

| Resource | Initial limit |
|---|---:|
| Submitted code | 1 MiB |
| Bridge frame | 16 MiB |
| Pending executions | 16 |
| Single text output event | 256 KiB |
| Retained output per execution | 64 MiB |
| PNG representation | 32 MiB |
| In-memory recent transcript | Bounded by events and bytes |
| Graceful shutdown deadline | 5 seconds |
| Heartbeat timeout | 10 seconds |
| Unresponsive → lost escalation | 30 seconds |

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
- No current client lease references the session.
- The idle timeout has elapsed.
- The host is not in a transient suspend/resume state.

Scient emits a warning event before shutdown.

### 18.3 Concurrency

Candidate defaults:

- Two concurrent kernel startups per server.
- A configurable maximum number of live sessions.
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
*"Actor identity is deliberately not represented as a nullable execution-receipt
placeholder. Before agent- or automation-triggered runs land, the accepted
Scient operation envelope must supply the host-resolved actor, project scope,
capabilities, authority generation, and operation lineage; the result receipt
then binds to that envelope rather than trusting an analysis-RPC payload."*

### 19.2 Agent session ownership

Agent-created sessions are owned by environment, project, thread, provider
session, and operation lineage. An agent cannot attach to a user's interactive
session without an explicit future sharing grant.

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

## 20. Implementation Phases

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
- Fake R adapter over the Jupyter transport abstraction.
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

**Exit gate:** A real Python kernel reliably executes, interrupts, restarts,
emits PNG output, and terminates without orphan processes on macOS, Windows,
and Linux.

---

### Phase 3: Session service and durable record

**Purpose:** Create the server-owned stateful runtime.

**Concrete changes:**

- Add `computeDir` to `ServerConfig` and boot-time `makeDirectory`.
- Implement `ComputeSessionService.ts`.
- Implement bounded queueing (one active, 16 pending, FIFO).
- Implement generation semantics and stale-command rejection.
- Implement lifecycle supervision (heartbeat, idle timer, unresponsive → lost).
- Implement `LocalComputeStore.ts` (session.json, journal.ndjson, execution
  records, output.ndjson, outputs/).
- Persist requests, results, output, and PNG files.
- Recover interrupted sessions as `lost` on next boot.
- Add `compute-output` asset resource and `AssetAccess` resolution.
- Add explicit cleanup and retention accounting.
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
- Add environment selection UI in `apps/web/src/scient/compute/`.
- Add execution transcript, stdout/stderr, traceback, and PNG rendering.
- Add editor actions (run selection, cell, file in session).
- Add interrupt, restart, and stop controls.
- Update `scient-analysis-seams.json` with new owned roots and diff signals.
- Update release-smoke inventory.
- Add user and internal documentation.

**Tests:**

- Transcript folding of snapshot + delta + out-of-order chunks.
- Bounded retention.
- Stale-generation rejection.
- End-to-end: select Python, start session, run two state-dependent
  executions, view a figure, interrupt, restart, review history after app
  restart.

**Product exit gate:** A scientist can:

1. Select Python.
2. Start a project session.
3. Execute dependent pieces of code.
4. Inspect text and a figure.
5. Interrupt a long operation.
6. Restart the namespace.
7. Review the prior history after restarting Scient.

---

### Phase 5: Hardening and scale

**Purpose:** Make retained and remote use reliable before broad release.

**Concrete changes:**

- Add SQLite session/execution projection (`ComputeSessionIndex.ts`).
- Add keyset pagination.
- Add gap-detecting subscription recovery.
- Add bounded multi-client attachment.
- Add idle-retention policy.
- Add resource telemetry integration (bridge/kernel PIDs in
  `ResourceTelemetry`).
- Add output-flood protection.
- Add corruption isolation.
- Add stale-process cleanup using PID, start time, and owner token.
- Complete Windows and Linux packaged-app acceptance.
- Decide and, if required, implement the app-owned bridge runtime.

**Tests:**

- Fault injection: bridge crash, kernel crash, output flood, cancel race,
  restart race.
- Long-running soak test.
- Startup storm (multiple concurrent kernel startups).
- No orphan processes after forced shutdown.
- No unbounded memory growth.

**Exit gate:** Fault injection, restart races, output floods, and
long-running sessions do not create orphan processes, unbounded memory,
corrupt history, or lying UI state.

---

### Phase 6: Scientific usability

**Purpose:** Turn execution into a stronger everyday scientific environment.

**Add incrementally (each with its own contract and safety gate):**

1. Variable list and bounded previews.
2. NumPy array inspection.
3. pandas and Polars table previews.
4. SVG output.
5. Plotly MIME output (reuse existing `plotlySpec.ts` validators).
6. Vega-Lite MIME output (reuse existing `vegaLiteSpec.ts` validators).
7. Sandboxed HTML.
8. Completion and inspection.
9. Multiple sessions per project.

Each addition receives its own contract and safety gate. These do not need to
land as one release.

---

### Phase 7: Operation envelope and agents

**Purpose:** Allow agents to use compute sessions without weakening authority
or provenance.

**Implements:**

- Host-derived operation envelope.
- Actor identity, project scope, capabilities, authority generation,
  operation lineage.
- Receipt binding to operation IDs.
- Provider-owned sessions.
- MCP read and execute capabilities.
- Structured execution results.
- Cross-provider isolation.

**Exit gate:** No provider can inspect or operate another provider's session,
and agents cannot attach to user sessions without an explicit grant.

---

### Phase 8: Additional languages

**R:**

Add a real R adapter using the existing Jupyter transport:

- R discovery.
- IRkernel verification.
- R diagnostic normalization.
- R variable inspection.

Reuse: session coordinator, Jupyter transport, persistence, output rendering,
authorization, artifact resolution.

**Julia:**

Repeat through IJulia.

**MATLAB:**

Evaluate:

- MathWorks' official Jupyter kernel (`jupyter-matlab-proxy`).
- MATLAB Engine transport.
- Existing batch analysis adapter.

The existing compute coordinator must not require modification merely to
support a different transport.

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

1. User-selected scientific Python (first release).
2. App-owned bridge runtime (separate proposal after spike evidence).
3. Fully managed scientific Python environment (separate proposal covering
   Python version, package baseline, upgrades, disk usage, and package
   installation policy).

Evidence for one does not automatically approve the others.

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
- Client folding: snapshot + delta, out-of-order chunks, bounded retention,
  gap recovery.
- Seams: `pnpm analysis:seams:check` extended to compute roots.

---

## 24. Final Recommendation

Approve the following architectural direction:

1. `ComputeSession` as a separate stateful scientific domain, not an analysis
   mode.
2. Python first.
3. Jupyter through a framed bridge, not Node-native ZMQ.
4. Duplex process supervision as a shared execution foundation.
5. Honest generation, interrupt, restart, and loss semantics.
6. Focused local persistence with filesystem as canonical truth.
7. Compute-owned initial outputs, no premature shared artifact migration.
8. One default project session in the first UI.
9. No agent execution before the operation envelope.
10. No managed Python or shared artifact migration without separate evidence.
11. Prove the foundation with Python, then validate cross-language reuse with
    R.
12. Extract broader shared abstractions only after real duplication is
    demonstrated.

Then implement the smallest complete vertical slice (Phases 0–4) before
expanding into variables, richer MIME, managed environments, additional
languages, or agent operations.

This plan keeps the long-term foundation scalable while ensuring the first
investment produces immediate scientific value rather than a large collection
of infrastructure with no finished user loop.
