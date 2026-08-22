# Compute session Phase 3: session service and durable record

Status: Implemented local candidate; focused macOS qualification green;
stable-snapshot and hosted cross-platform qualification pending.

Implementation plan for Phase 3 of
[the compute session foundation](./scient-compute-session-foundation.md).
At the Phase 3 planning boundary, Phases 1 and 2 existed as a pure contract
package and a working Jupyter bridge transport. Neither held state:
`ComputeChannel` was a live conversation that a caller had to own, and no
compute record was written to disk.

The implementation below supplies the missing half. Its exit gate is one sentence from the
foundation document:

> The server can lose or restart a kernel without losing historical truth or
> leaving a false "running" state.

That sentence is the whole design constraint. Every decision below is answerable
to it.

---

## 1. Scope

**In scope (server-side only):**

- two new pure modules in `packages/scient-compute` — the durable record shapes
  and the queue policy;
- `LocalComputeStore.ts` — the filesystem as the authority on what happened;
- `ComputeSessionService.ts` — the live registry, supervision, and recovery;
- production layers for the language adapter and the probe it needs;
- the `compute-output` asset resource and its `AssetAccess` resolution;
- `computeDir` in `ServerConfig`, boot-time directory creation, `server.ts`
  wiring, and the bridge-script staging the packed build needs;
- seam-manifest entries for every inherited file touched.

**Deliberately out of scope (Phase 4):** RPC contracts, `RpcAuthorization.ts`,
the session handlers in `ws.ts`, `packages/client-runtime/src/state/compute.ts`,
and every pixel of UI. Phase 3 ends with a service that has no client. That is
the point: the durability and loss semantics are provable without a screen, and
implementing them first lets Phase 4 consume established server semantics rather
than discover them through client work. The one `ws.ts` edit Phase 3 does make
is the `assetsCreateUrl` branch that resolves a
compute output, because the resource above is in scope and only `ws.ts` holds
the service that can resolve it — §8 says why the alternative is worse.

**Also out of scope, on the foundation document's own instruction:** the SQLite
session/execution index (§13.5 defers it until list latency is measured), and
any packaged Python runtime (§ Phase 2 exit criteria hold it as a separate
decision).

---

## 2. Findings that change the plan

Five facts about the code as it stands are not in the foundation document and
each one changes what Phase 3 has to do.

### 2.1 The bridge script does not survive the packed build

`apps/server` is bundled by `vp pack` into `dist/*.mjs`, and its `package.json`
publishes only `dist`. Nothing copies non-JavaScript files. So
`scient_compute_bridge.py`, which lives beside its TypeScript neighbours in
`src/scient/compute/bridge/`, exists in a checkout and in tests and nowhere in a
release.

This has been invisible until now because Phase 2 made the bridge path an
_input_: `makePythonRuntimeAdapter(spawnProbe, bridgePath)` takes it, and every
test passes a path it knows. Phase 3 is where a production layer first has to
answer the question itself, so Phase 3 owns the answer.

The plan adds one copy step to `apps/server/scripts/cli.ts` — the script that
already assembles the server distribution and already copies `apps/web/dist`
into `dist/client`. The runtime resolver then looks in the source layout first
and the staged layout second, so a checkout, a test, and a release all find the
same script. A unit test keeps the runtime and build destination in agreement,
and the publish command refuses an artifact whose staged copy is absent —
because the failure mode otherwise is a user's first execution, not a build.

### 2.2 There is no production probe spawner

`makePythonRuntimeAdapter` takes `spawnProbe` as a parameter and the only
implementations are fakes in tests. `discover`, `verify`, and
`fingerprintEnvironment` are therefore all unreachable in production today.

Phase 3 adds one, on `ExecutionProcessPort` — the existing one-shot process
port, which already gives a bounded output stream, an exit code, and a cancel.
The probe runs `python -c PROBE_SCRIPT` under the same sanitized environment
`sanitizeComputeEnvironment` builds for a launch, because a fingerprint taken
under a different environment than the launch would describe a runtime that
never ran.

### 2.3 Identifiers are not path-safe

`ComputeSessionId` and `ComputeExecutionId` are `Schema.NonEmptyString` with a
length bound. Nothing stops `../../etc`. Both are used as directory names.

`LocalAnalysisStore` joins its own identifiers the same way and is safe only
because they are server-minted; that is a property of its callers, not of its
code. The compute store will not rely on that: a session identifier may be
supplied by a caller for idempotency, so the store validates every identifier as
a single safe path segment before it joins anything, and refuses otherwise. The
image file name is derived from a validated hex content hash rather than from
stored text, which makes traversal structurally impossible on the one path where
a corrupted record could otherwise choose a filename.

### 2.4 "Heartbeat" is already implemented, in Python

The foundation document lists "lifecycle supervision (heartbeat, idle timer,
unresponsive → lost)". There is no `heartbeat` message in `BridgeMessageType`,
and there should not be one: the bridge already polls `is_alive()` every
`LIVENESS_INTERVAL` while an execution runs and turns a dead kernel into `fatal`,
which the transport reports as one honest `lost`. Liveness is detected next to
the process that can actually observe it.

So server-side "heartbeat" work is already done, and the server must not invent a
second liveness signal. Deriving unresponsiveness from silence would be actively
wrong: a legitimate ten-minute computation is silent by design.

`activity: "unresponsive"` is instead derived from a real observation that costs
no new protocol — an `interrupt` that returns `timeout` while its execution is
still running. That is precisely "the runtime accepted the signal and never went
idle", which is what unresponsive means.

### 2.5 The document contradicts itself on escalation, and §12.4 wins

§17 lists "unresponsive → lost escalation: 30 seconds". §12.4 says the session
"does not silently destroy the namespace". These cannot both hold: escalating to
`lost` is terminal, and a terminal session's namespace is gone.

Phase 3 follows §12.4. A session that ignored an interrupt is reported as
`unresponsive` and left running; the user decides whether to restart it. The
alternative throws away a scientist's hours-long computation because a signal
was slow, which is the exact failure §12.4 exists to prevent. The `unresponsive`
state is not a dead end — it returns to `busy` if the execution completes, and to
`idle` after it does.

This should be corrected in the foundation document rather than left as a
contradiction future work has to re-adjudicate.

---

## 3. Architecture

Dependency direction is strictly one way, and each layer is testable without the
one above it:

```
packages/scient-compute          contract, state machines, record, queue   (pure)
        ^
LocalComputeStore.ts             filesystem is the authority               (I/O)
        ^
ComputeSessionService.ts         live registry, supervision, recovery      (state)
        ^
server.ts / AssetAccess.ts       wiring and the signed-URL seam            (seams)
```

The hard parts are pushed down as far as they will go. Queue order, position
accounting, and cancel semantics are a pure reducer with no Effect and no clock,
so the logic that is easiest to get subtly wrong is the logic that is cheapest to
test exhaustively. Durability is a store with no concept of a live session.
Supervision is a service with no concept of a file format.

### 3.1 What the service owns per session

One `LiveComputeSession` per running session, held in a `Ref<Map>` keyed by
`projectId/sessionId`:

- its own `Scope`, so stopping one session closes one transport and nothing
  else;
- the `ComputeChannel` from the transport;
- a `Ref<ComputeSessionRecord>` — the same shape that is on disk, so there is
  one truth and not a memory copy that can drift from it;
- a `Ref<ComputeQueueState>`;
- a mutation `Semaphore(1)`, so two concurrent commands cannot interleave a
  read-decide-write against the same session;
- the fiber draining `channel.events`.

A session's record is written to disk before it is published to subscribers.
A subscriber that reads a state the disk does not yet hold would survive a crash
believing something the server cannot prove.

---

## 4. `packages/scient-compute/src/record.ts`

Durable shapes. New file, exported from `index.ts`. No existing schema covers
any of this — `contract.ts` describes a live conversation, not a stored one.

```
ComputeSourceRange          startLine, startColumn, endLine, endColumn
ComputeExecutionSource      union of:
                              console  (no locator)
                              document (origin: file|selection|cell, path,
                                        bufferState: saved|dirty,
                                        revision|null, range|null)
ComputeSessionRecord        sessionId, projectId, label, languageId,
                            transportKind, runtime profile|null,
                            identity|null, workingDirectory,
                            environmentFingerprint|null, generation,
                            status, activity, activeExecutionId|null,
                            pendingCount, storage, createdAt,
                            lastActivityAt, closedAt|null, lostReason|null
ComputeExecutionRequestRecord   executionId, sessionId, generation, code,
                                codeHash, source, submittedAt,
                                environmentFingerprint|null
ComputeExecutionResultRecord    executionId, status, outcome|null, startedAt|null,
                                finishedAt|null, diagnostics, outputCount,
                                outputBytes, truncated, failureReason|null
ComputeExecutionRecord          request + result|null   (a read view)
ComputeSessionJournalEntry      sequence, observedAt, event, generation,
                                executionId|null, detail|null
ComputeOutputResourceRef        projectId, sessionId, executionId, contentHash
ComputeSessionStreamEvent       session-snapshot | session-updated |
                                execution-updated | execution-output
```

Two decisions worth stating.

**The request and the result are separate records.** The request is written once
and never rewritten; the result is rewritten as the execution progresses. A
crash can therefore corrupt the mutable half and never the submitted code. This
is also what makes recovery honest: a request with no result is an execution
that was in flight when the server died, which is exactly the case that must
become `lost`.

**`ComputeExecutionSource` is a union, not a struct with three nullable
fields.** A console execution has no path, no revision, and no range; a struct
would let a caller store a path for one and a future reader would have to guess
whether it means anything.

For document executions, `bufferState` is required. `saved` means the submitted
bytes matched the recorded durable revision; `dirty` means the immutable request
record, not the current project file, is authoritative for what ran. A dirty
submission may still record the saved revision on which the editor buffer was
based. Phase 4 owns deriving these facts from the editor without forcing an
autosave.

---

## 5. `packages/scient-compute/src/queue.ts`

A pure reducer over `{ active, pending }`, matching the style of the two existing
state machines so the same review habits apply.

```
MAXIMUM_PENDING_COMPUTE_EXECUTIONS = 16

admitComputeExecution(state, entry)   -> Effect<{state, position}, ComputeQueueFullError>
startNextComputeExecution(state)      -> {state, started: entry|null}
finishComputeExecution(state, id)     -> state
cancelComputeExecution(state, id)     -> {state, removed: "active"|"pending"|null}
drainComputeQueue(state)              -> {state: empty, active|null, cancelled[]}
computeQueuePositionOf(state, id)     -> number|null
```

`admit` is the only member that can fail, and it fails typed: a full queue is a
condition to report to a user, not a defect. Everything else is total.

`drain` exists for restart and shutdown, which §12.3 defines as clearing the
queue: the queued code was written against a namespace that is about to stop
existing, so running it afterwards would execute it against different state than
its author saw. Draining returns what it cancelled so the caller can record each
one — a silently dropped execution is a lost record.

`position` is stored on the record rather than derived at read time. A client
showing "3rd in queue" must see the same number the server used, and a position
recomputed on each read from a list that has since changed is a different
number.

---

## 6. `apps/server/src/scient/compute/LocalComputeStore.ts`

### 6.1 Layout

```
<stateDir>/compute/sessions/<projectId>/<sessionId>/
    session.json                        atomic whole-file write
    journal.ndjson                      append-only
    executions/<executionId>/
        request.json                    written once
        result.json                     atomic whole-file write
        output.ndjson                   append-only
        outputs/<sha256-hex>.png        content-addressed image bytes
```

Content-addressed image files mean a figure produced twice is stored once, and
the file name cannot be chosen by a corrupted record.

### 6.2 Safety rules

Each is a rule the store enforces, not a convention its callers follow:

1. **Path segments.** Every identifier used as a directory name is validated
   against a single-safe-segment rule (no separator, no `.`/`..`, no NUL, no
   control characters, bounded length) before any join. A violation is a typed
   failure.
2. **Content hash.** `contentHash` is validated as `sha256:<64 hex>` before it
   becomes a filename.
3. **No symlinks.** Image resolution uses `lstat` and rejects anything that is
   not a regular file, then canonicalizes and confirms the result is still under
   `computeDir`. A store that followed a symlink out of its own directory would
   sign a URL for an arbitrary file.
4. **Bytes must match the record.** Resolution verifies the file's size against
   the recorded `byteLength` and rehashes it against the recorded `contentHash`.
   A mismatch is a refusal, not a smaller image.
5. **Corrupt lines are counted, not fatal.** A malformed `output.ndjson` line is
   skipped and reported in a count, matching `LocalAnalysisStore`. A single bad
   line must not make a transcript unreadable.
6. **An unreadable `session.json` is reported.** It fails typed rather than
   being treated as an absent session, because "no session" and "a session whose
   record I cannot read" are different facts and only one of them is safe to
   overwrite.
7. **Bytes before metadata.** An image's file is written before the
   `output.ndjson` line that references it, so a crash can leave an orphaned file
   (harmless, garbage-collectable) but never a reference to a missing file.

### 6.3 Interface

`create`/`write` for sessions, journal, requests, results, outputs, and image
bytes; `loadSessions`/`loadSession`/`loadExecutions`/`loadOutputs` for reads;
`resolveOutputImage` for the asset seam; `measureSessionStorage` and
`removeDisposableSessionData` for retention. Cleanup is metadata-preserving: it
moves output and image data aside and rewrites the record as `metadata-only`,
exactly as analysis cleanup does, so history survives reclamation.

---

## 7. `apps/server/src/scient/compute/ComputeSessionService.ts`

### 7.1 Commands

```
startSession        idempotent on (projectId, sessionId); single-flight
submitExecution     generation-checked; queue-bounded; request persisted first
cancelExecution     queued -> cancelled directly; active -> interrupt
interruptSession    outcome recorded; timeout-while-running -> unresponsive
restartSession      generation advances; queue drained; history preserved
stopSession         graceful shutdown, then scope close
listSessions / getSession / listExecutions / listOutputs
subscribeSessions   snapshot-then-live, on the analysis boundary-sequence pattern
resolveOutputImage  delegates to the store
```

Every mutating command carries `expectedGeneration` and runs it through
`checkComputeSessionGeneration` — which Phase 1 wrote and which has had zero
production callers until now. `stale` is a message for a client that has not
seen a restart; `ahead` is logged as a defect, because no client observing the
truth could produce it.

### 7.2 The event drain

One fiber per session consumes `channel.events` and, for each event, persists
before publishing:

| event           | effect                                                                     |
| --------------- | -------------------------------------------------------------------------- |
| `ready`         | identity + fingerprint recorded, status `ready`, queue starts              |
| `accepted`      | execution `submitting` → `running`, `startedAt` set                        |
| `output`        | image bytes written first, then the `output.ndjson` line; counters updated |
| `runtime-error` | normalized by the language adapter into diagnostics at the same sequence   |
| `completed`     | result finalized, queue advanced, next execution started                   |
| `restarted`     | generation and identity replaced, queue already drained                    |
| `lost`          | session `lost`, active execution `lost`, queued `cancelled`, all persisted |

Output that arrives with a null `requestId` belongs to the session, not to
whichever execution happens to be running. It is stored against the session
transcript. Attributing a stray thread's print to an unrelated cell is a
correctness bug that looks like a rendering bug.

### 7.3 Recovery

Recovery is lazy per project, on first read, guarded by a lock and a
`recoveredProjects` set — the same shape as `ensureProjectRunsLoaded`. This is
not a shortcut: a stale record cannot be observed before it is read, so
recovering at first read is equivalent to recovering at boot and does not make
startup pay for every project a user has ever opened.

For each session whose stored status is non-terminal:

- the session becomes `lost`, with a reason that says the server restarted;
- its active or in-flight executions become `lost`;
- its queued executions become `cancelled`;
- a `session-recovered` journal entry is appended;
- **no code is replayed.** Re-running a scientist's code without being asked is
  the worst thing this service could do.

### 7.4 Idle timer

An explicit `idleTimeoutMs` option, **disabled by default**. When set, a session
is stopped only if it is `ready`, has no active execution, has an empty queue,
and its last activity is older than the timeout. A session holding a namespace a
user cares about is not idle merely because it is quiet, so the default is off
until a client exists that can tell the server a user has gone away. Phase 4
adds leases; inventing a lease API before there is a client to hold one would be
speculative.

### 7.5 Shutdown

A layer finalizer stops every live session with a bounded deadline, then closes
the scopes. An interpreter that outlives the server it was started by is a
leaked process on a user's machine.

---

## 8. Seam changes

Every inherited file touched, and the anchor added to
`scient-analysis-seams.json`:

| file                                    | change                                    | anchor                         |
| --------------------------------------- | ----------------------------------------- | ------------------------------ |
| `apps/server/src/config.ts`             | `computeDir` + `makeDirectory`            | `analysisDir` (existing)       |
| `apps/server/src/server.ts`             | layer wiring                              | `AnalysisService` (existing)   |
| `apps/server/src/assets/AssetAccess.ts` | `compute-output` claims + resolution      | `analysis-artifact` (existing) |
| `packages/contracts/src/assets.ts`      | `compute-output` resource kind            | `analysis-artifact` (existing) |
| `apps/server/src/ws.ts`                 | `assetsCreateUrl` resolves compute output | `analysisStartRun` (existing)  |
| `apps/server/scripts/cli.ts`            | stage the bridge, gate publishing on it   | `scient-compute-bridge` (new)  |

The anchors are not what this section first proposed, because
`verify-scient-analysis-seams.mjs` rejects a manifest with two entries for the
same path (`duplicate analysis mount`). Every file above except `cli.ts` is
already mounted for analysis, so compute extends the existing entry's `purpose`
rather than adding a second anchor. That is the honest shape anyway: the mount
records that a file carries Scient-owned code, and one file has one such record.

`packages/contracts` gains a dependency on `@scientfactory/compute`, mirroring
its existing dependency on `@scientfactory/analysis`. The resource ref schema
itself lives in the owned package and `assets.ts` spreads its fields, so the
inherited file gains six lines and no compute knowledge.

`AssetAccess` receives an already-resolved image from its caller, exactly as it
receives an already-resolved analysis artifact. It re-canonicalizes and re-checks
containment itself rather than trusting the caller — a signed URL is a capability
and the code that mints one does not delegate its own precondition.

The staged-bridge assertion lands in `cli.ts`'s `publishCmd`, beside the existing
`dist/bin.mjs` and `dist/client/index.html` checks, not in
`scripts/release-smoke.ts` as this section first said: that script's
`workspaceFiles` is a list of fixtures it copies into a scratch workspace, not a
list of build outputs it verifies. Gating in `publishCmd` also fails earlier —
before an artifact is published rather than after.

Resolving a compute output needs `ComputeSessionService`, which lives in `ws.ts`,
so the `assetsCreateUrl` branch is here rather than deferred to Phase 4 with the
rest of the handler work. The alternative — giving `issueAssetUrl` a store
dependency — would make every caller and every asset test provide a compute
store for resource kinds that have nothing to do with compute.

---

## 9. Tests

The foundation document names six required cases. Each maps to a concrete test:

| required case                            | where                                                                                                              |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| interrupted writes and corrupted records | `LocalComputeStore.test.ts` — truncated `session.json`, half-written `result.json`, malformed `output.ndjson` line |
| hash mismatch rejection                  | `LocalComputeStore.test.ts` — mutate the file under a valid record                                                 |
| path traversal and symlink rejection     | `LocalComputeStore.test.ts` — `../` identifiers, a symlink pointing outside `computeDir`                           |
| server-restart recovery to `lost`        | `ComputeSessionService.test.ts` — a second service over the same directory                                         |
| output truncation markers                | `ComputeSessionService.test.ts` — per-execution and per-session byte ceilings, one marker each                     |
| metadata-preserving cleanup              | `LocalComputeStore.test.ts` — history survives, bytes do not                                                       |

Plus, beyond the required set: the pure queue reducer exhaustively; schema
round-trips and limit enforcement for every record; generation staleness on
every mutating command; restart clearing the queue while preserving history; the
idle rule under `TestClock`; and the one agreement no lane would otherwise
notice breaking — `PythonComputeRuntime.test.ts` reads `scripts/cli.ts` and
asserts the directory the build stages the bridge into is still the directory
the runtime looks in.

Service tests run against `createSimulatedComputeTransport`, which Phase 1
already provides. No Python, no kernel, no sleeping — a full session lifecycle
including loss and restart is exercised deterministically. The real-kernel suite
stays where it is and keeps proving what only a real kernel can.

Two rules learned the hard way in Phase 2 apply throughout: `it.effect` installs
a `TestClock`, so anything waiting on a real process must be `it.live`; and a
deliberate timeout test uses `it.effect` with `TestClock.adjust` rather than
waiting.

---

## 10. Verification

```
pnpm exec vp fmt --check <changed paths>
pnpm exec vp lint --report-unused-disable-directives <changed TypeScript paths>
pnpm exec vp run --filter @scientfactory/compute typecheck
pnpm exec vp run --filter @scientfactory/compute test
pnpm exec vp run --filter t3 typecheck
pnpm exec vitest run src/scient/compute src/scient/execution     # in apps/server
python3 -m unittest discover -s apps/server/src/scient/compute/bridge -p 'test_*.py'
node scripts/verify-scient-analysis-seams.mjs --base <base> --head HEAD \
  --upstream-ref refs/remotes/upstream/main
git diff --check
```

The real-kernel suite runs with `SCIENT_TEST_PYTHON` pointed at a 3.10+
interpreter that has `jupyter_client` and `ipykernel`.

These commands establish focused local evidence. Phase completion is recorded
only against a stable candidate snapshot; hosted macOS/Linux/Windows evidence
and packaged-app acceptance stay in the foundation ADR's qualification ledger.

---

## 11. Decisions taken during implementation

Key judgement calls that the sections above do not imply, recorded so a later
reader does not have to reconstruct them from the diff.

**A missing Python runtime degrades; it does not fail the boot.**
`PythonComputeRuntime.layer` catches a failed binding, logs a warning, and
provides zero runtimes. A host with no Python, or a build that lost the bridge,
therefore serves every session request as `runtime-missing` while the rest of
the app starts normally. Failing the layer would have taken the whole server
down over an optional feature.

**The interpreter probe runs through `ExecutionProcess`, under the launch's own
environment.** `ExecutionProcessRequest` gains one optional field,
`extendEnv?: boolean`, so a caller that has already sanitized a complete
environment can stop the process layer from merging the host's back in — which
is what the duplex launch already does. Probing under a different environment
than the bridge runs in would let the probe report packages the bridge cannot
import.

**The session output ceiling spans executions; the execution ceiling does not.**
Every byte kept is charged against both budgets, so
`maximumSessionOutputBytes` bounds a whole session's transcript rather than only
the output no execution claimed. A session that fills by writing a little at a
time is the failure the per-execution ceiling cannot see, and a limit that only
counted stray output would not have bounded anything a user is likely to hit.
When the session's ceiling is what a line crosses, both that line's execution
and the session are marked incomplete, because a client looking at that one cell
still has to be told its output was cut short.

The session ceiling is lifetime-wide and is not reset by kernel restart.
Diagnostics and invalid image references pass through the same retention path
as ordinary output, so neither can bypass the ceiling and every refusal leaves a
persisted marker.

**Execution identifiers are immutable request identities.** A repeated ID is
idempotent only when session, generation, code, hash, and source match. A
different request is a conflict even after the first execution is terminal;
the store refuses direct request rewrites as a second line of defense.

**Live delivery is bounded and recoverable.** The socket-facing stream is a
512-event sliding notification channel, not transcript authority. A slow or
abandoned subscriber cannot stop a kernel or grow memory without bound;
sequence gaps require a client to re-read the durable list/output APIs.

**The bridge is looked for in the source tree first, then in `dist`.**
`bridgePathCandidates` returns `<dir>/bridge/…` before
`<dir>/scient-compute-bridge/…`, so a developer editing the bridge is never
served yesterday's staged copy. Both layouts are reachable because
`import.meta.url` survives rolldown and `dist` is flat apart from `dist/client`
— verified by running the real build, not by reading the bundler's docs.

**Reclaiming storage ships unwired, and journals what it removed.**
`LocalComputeStore.removeDisposableSessionData` has no caller in the server.
_Which_ sessions to trim, and after how long, is a retention policy the
foundation document defers; picking a schedule here would have decided it by
accident. What was settled instead is the part that outlives any schedule: the
trim rewrites the record before it deletes anything, keeps each execution's
request and result, and appends a `storage-trimmed` journal entry saying how
many bytes went. A reader a month later has the journal, not the log, and is
told why the figures are gone rather than shown a session that appears to have
produced none.
