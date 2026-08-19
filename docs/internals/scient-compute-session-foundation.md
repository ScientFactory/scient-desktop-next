# Stateful Scientific Compute Foundation

Status: Proposed (not yet accepted)
Owner: Yaacov
Created: 2026-08-18
Purpose: Defines the architecture, domain model, transport boundary, persistence semantics, and phased implementation plan for stateful interactive scientific compute sessions in Scient. Written as a companion to the accepted `scient-analysis-runtime-foundation.md`, which governs one-shot terminal execution.
Doc type: Architecture decision record (proposed)

## Planning Posture

This is the first implementation plan for this subsystem, not a blind
implementation mandate. It is a starting hypothesis intended to make the
design reviewable. Improvement ideas, alternative designs, and architectural
changes are explicitly welcome when they are justified from first principles,
validated against the product goals, and shown to improve usefulness,
reliability, scalability, or maintainability. Implementation should follow
the best reviewed design, not this document mechanically.

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

| System                      | Purpose                                  | Lifecycle                                                |
| --------------------------- | ---------------------------------------- | -------------------------------------------------------- |
| `AnalysisRun`               | Isolated, terminal file/task execution   | One process, one exit code, one terminal result          |
| `DocumentBuild`             | Revision-bound LaTeX/document production | Build → publish → binding lifecycle                      |
| `ComputeSession` (proposed) | Long-lived interactive namespace         | Many executions, persistent variables, interrupt/restart |

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

Later variable inspection belongs here as a capability.

The coordinator, not the language adapter, constructs `TransportOpenRequest`.
This keeps session identity, generation, transport selection, and required
capabilities under session policy; the adapter owns only language-specific
launch preparation.

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
  | StreamOutput // stdout/stderr text
  | DiagnosticOutput // exception type, message, traceback frames
  | ImageOutput // PNG figure with content hash and signed resource
  | SystemOutput; // session started, interrupted, restarted, lost, truncated
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

| Resource                       |               Initial limit |
| ------------------------------ | --------------------------: |
| Submitted code                 |                       1 MiB |
| Bridge frame                   |                      16 MiB |
| Pending executions             |                          16 |
| Single text output event       |                     256 KiB |
| Retained output per execution  |                      64 MiB |
| PNG representation             |                      32 MiB |
| In-memory recent transcript    | Bounded by events and bytes |
| Graceful shutdown deadline     |                   5 seconds |
| Heartbeat timeout              |                  10 seconds |
| Unresponsive → lost escalation |                  30 seconds |

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
_"Actor identity is deliberately not represented as a nullable execution-receipt
placeholder. Before agent- or automation-triggered runs land, the accepted
Scient operation envelope must supply the host-resolved actor, project scope,
capabilities, authority generation, and operation lineage; the result receipt
then binds to that envelope rather than trusting an analysis-RPC payload."_

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
| bridge → server | `display`            | Emit one selected PNG or bounded text fallback.                                                  |
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
- Diagnostic stderr is not protocol. Node drains it concurrently from spawn,
  retains only a bounded tail for failure context, redacts the owner token if
  encountered, and never forwards arbitrary stderr as user output.
- On protocol stdout EOF, Node calls decoder `finish()` before interpreting
  process exit. Partial data is truncation even if the process exit code is
  zero.

Keep golden JSON fixtures intentionally small. Generated PNG bytes belong in
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
- importable `jupyter_client` 8.6 or newer;
- importable `ipykernel` 6.29 or newer;
- successful kernel startup and `kernel_info_request`;
- Python language identity returned by the kernel.

These minimums reflect APIs used by the bridge. Do not add an upper version
bound without evidence. A newer environment is accepted only after the
capability/startup probe succeeds. Missing modules, unsupported versions,
wrong architecture, timeout, malformed probe output, and startup failure map
to distinct actionable verification messages. Verification never runs
`pip`, writes into the environment, registers a kernelspec, or imports large
scientific packages merely to discover their versions.

The environment fingerprint includes executable identity, Python
implementation/version, prefix, and the discovered versions or absence of
required bridge/kernel distributions. It is provenance, not a safe
verification-cache key: package contents can change without changing the
interpreter executable. Phase 2 does not cache verification. Phase 3 must
either reverify before session launch or define a stronger invalidation proof.

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
   `terminal` if completion won the race. Rejection or a 10-second response
   timeout fails the interrupt call without inventing a second request ID.
4. Continue correlating the active request's reply-plus-idle.
5. Complete the execute request as `cancelled` when interruption is observed.
6. If idle does not return within 10 seconds, report unresponsive and leave
   destructive restart to the caller; do not silently replace the namespace.

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

Node waits for `shutdown-complete`, clean protocol EOF, and bridge exit.
Missing any one of these triggers process-tree cancellation and a shutdown
error. Repeated shutdown/finalization is idempotent.

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
partially decoded. Node, not Python, computes the trusted image hash and
optionally reads PNG dimensions with a bounded, dependency-free header parser.
Width/height remain null when not safely available.

Python traceback normalization strips ANSI/control sequences, bounds every
field, preserves the human-readable traceback, and extracts no filesystem
authority from traceback strings. Phase 2 does not attempt source mapping or
path authorization; Phase 3 can enrich frames against an authorized project.

##### 2.11 Test strategy

All mandatory unit tests run without Python:

- envelope payload schemas for every message type and direction;
- wrong version/session/generation/token/type/request/sequence;
- golden Jupyter-to-Scient fixtures for stream, result, PNG, error, busy/idle,
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
5. one Matplotlib PNG with verified signature/hash;
6. interrupt of an infinite loop with prior namespace intact;
7. restart with old namespace absent and a different live kernel PID;
8. bridge crash and kernel crash produce loss;
9. graceful shutdown removes bridge, kernel, and connection files;
10. forced cancellation leaves both recorded PIDs dead.

Cross-platform CI must provision this fixture on macOS, Windows, and Linux
before the Phase 2 exit gate can pass. Local absence may skip only the real
kernel suite with a visible reason; it may not skip protocol, bridge-unit, or
adapter tests.

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
   liveness, connection-file cleanup on all three operating systems.
8. **Boundary review:** dependency, seam, security, failure-semantics, and
   no-scope-creep audit.

Do not begin Phase 3 merely because the happy-path integration test passes.
Phase 2 is complete only when:

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

Before implementation starts, a human must accept this ADR or explicitly
approve Phase 2 against its proposed status. Packaging an app-owned Python
runtime remains a separate decision. If the selected-environment proof is not
reliable enough for release, Phase 2 reports that evidence rather than quietly
expanding into a Python distribution project.

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
