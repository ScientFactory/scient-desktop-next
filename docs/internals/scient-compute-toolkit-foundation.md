# Scientific Compute Toolkits and Runtime Setup

Status: Installable local vertical-slice candidate; owner and cross-platform review pending
Owner: Yaacov
Created: 2026-08-30
Purpose: Records the reviewed Toolkit boundary and the first optional Scient-managed Python lifecycle, including what is shared, what remains user-owned, and what still requires qualification.
Doc type: Implementation note subordinate to `scient-compute-session-foundation.md`

## Product goal

Scient should make scientific capabilities easy to use for people who do not
want to manage Python packages themselves, while continuing to respect users
who already have a working environment. The product direction is:

- existing system, configured, and project-local runtimes remain supported;
- a Scient-managed environment becomes an optional assisted path, never a
  silent mutation of a user-owned Python;
- users and, later, authorized agents can request reviewed capability bundles
  through the same server-owned lifecycle;
- onboarding may briefly explain where setup lives, but should not become a
  package questionnaire or block first use; and
- each additional language or proprietary runtime keeps its own acquisition
  and licensing decisions instead of inheriting Python's mechanism.

This note describes an implementation candidate, not a release claim. Every
decision remains evidence-driven: implementation and qualification may refine
this document when a mechanism proves unreliable, unnecessarily complex, or
wrong for a supported platform.

## Phase one: runtime setup and MATLAB connection — 2026-09-10

This continuation completes the setup/connection slice, not the later MATLAB
session/result parity work. The implementation deliberately reuses a private
**Python environment** mechanism rather than introducing a general package manager.

| Responsibility                | Shared mechanism                                                                                                                                    | Language-specific policy                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Private environment lifecycle | `ManagedPythonEnvironment`, provisioner, controller: serialized generations, activation, rollback, cancellation, removal and startup reconciliation | Separate `python` and `matlab-connection` roots/receipts; independent selection and revisions                                                                        |
| Download/provisioning         | Pinned uv artifact, private CPython, locked specification and owned process runner                                                                  | Scientific Python's data Toolkit versus a minimal MATLAB helper with setuptools/wheel and the selected installation's Engine                                         |
| Runtime settings              | `ScientificRuntimePreferences`, server-scoped Settings and existing generic runtime RPCs                                                            | MATLAB's canonical executable is also read/written by the older analysis service; absent canonical settings read through the legacy choice without a migration write |
| Native connection proof       | Existing adapter prepare/open/shutdown path, serialized with session mutations                                                                      | MATLAB advertises passive `detected` status, requesting an explicit native verification; Python retains its existing verification semantics                          |
| UI                            | Existing Settings row and managed-runtime card with optional display text                                                                           | MATLAB acquisition/license explanation, helper-versus-MATLAB ownership and explicit Verify connection                                                                |

The helper lives under `<computeDir>/environments/matlab-connection/`. It uses the
same pinned CPython as managed Scientific Python, but **not** that environment or
its scientific packages. The two may be repaired/removed independently. Only
Scient-owned generations are writable/removable. MATLAB and system/project Python
remain user-owned. An installed helper may explicitly be deselected with Use existing.

`MatlabConnectionHelper` builds the selected MATLAB installation's own Engine
package into an unpublished private generation and validates its import and
`_arch.txt` installation identity before activation. It does not run pip against
system Python or write into the MATLAB bundle. CPython 3.12 is accepted only for the
explicit reviewed MATLAB release list R2024b–R2026a; a future release requires
review, not a permissive version comparison. Existing Engine hosts remain supported,
including installed Engine packages whose vendor metadata matches the selected
MATLAB. The lexical virtual-environment launcher is preserved while imported module
and MATLAB paths are canonicalized, including macOS `/var` versus `/private/var`.

Source references: [MathWorks Engine installation](https://www.mathworks.com/help/matlab/matlab_external/install-the-matlab-engine-for-python.html)
and [Python compatibility](https://www.mathworks.com/support/requirements/python-compatibility.html).
The accepted release list is not cross-platform qualification: native verification
in this pass is macOS arm64 / MATLAB R2026a. MATLAB Runtime alone is not MATLAB.

Passive discovery/import never starts MATLAB. Explicit Verify connection creates a
scoped transport using the same bridge as real runs, validates the handshake, then
shuts it down without a project session or history entry. Failures retain actionable
startup/license information. `detected`/`verified` are optional contract fields for
backward compatibility. The UI clears transient verification on refresh, environment,
runtime or helper selection changes and ignores stale in-flight results. Detected
executables remain visible when their connection is broken. Launch always reprobes.

Settings must finish saving the enabled language before assisted installation starts.
A failed settings save must not start an installer; remote settings remain scoped to
the selected environment. Helper generation/selection changes invalidate passive
Engine probes. Removal is serialized with session creation and explicit verification,
and is refused while a live MATLAB session exists. Failed repair preserves the prior
generation; selected-but-broken helpers never silently fall back to a different host.
The older analysis service also keys its cached profile by the current canonical
executable preference. Failed inspection of a newly selected path cannot reuse or
relabel the previous profile, and late verification cannot overwrite a newer choice.

### Settings inventory versus execution checks

Settings uses the read-only `compute.runtimeInventory` RPC. Each language adapter's
optional `listInstallations` operation reads executable paths and installation
metadata only: Python preserves the lexical virtual-environment launcher and reads
the managed receipt; MATLAB reads its installation's `VersionInfo.xml`. Neither
operation starts a process, imports MATLAB Engine, assesses packages, or claims
execution readiness. Adapters without this operation still return their language
metadata; there is no fallback to expensive discovery.

The service lists independent languages with bounded concurrency and retains each
language row when its own inventory fails. The environment-scoped client retains
recent observations for one minute while idle, revalidates on return, and invalidates
on settings/lifecycle changes. It polls only during an active managed operation and
stops polling when Settings is no longer observed. Refresh awaits one fresh inventory
request; it does not request an Engine/native check.

Explicit Verify connection and Run keep the existing full discovery/verification
and native transport boundaries. The original runtime-inspection API remains for
project/file surfaces that need package readiness. Inventory is never an admission
decision: stale observations cannot permit execution, helper removal, or replacement
of the selected runtime. MATLAB probe successes and failures share a bounded short
cache to avoid a duplicate import at discover-to-verify; explicit refresh bypasses
it, cancellation is not cached, and helper invalidation prevents in-flight results
from repopulating the old cache.

Regression coverage holds process operations indefinitely while exercising inventory,
removes/reinstalls synthetic runtimes, checks malformed metadata, independent-language
failure isolation, cached return-to-Settings, refresh deduplication and polling cleanup.
Native MATLAB/Python product tests remain separate execution-regression gates.

### Qualification and next boundary

Backend coverage includes isolation between both environment roots, failed repair
rollback, unsupported/missing MATLAB prerequisites without downloads, exact Engine
host selection, canonical preference read-through and explicit clears, and repeated
native verification success/failure without retained sessions. Opt-in native tests
cover both private-helper and existing-host MATLAB: stateful execution, user errors,
queued execution, output flooding, interrupt/recovery, restart and stop; the helper
case also installs and removes the helper and refuses removal during a live session.
The separate real Scientific Python install/run/remove test remains a regression gate.

The next local candidate implements [independent Compute tabs](scient-compute-session-foundation.md#next-pass-independent-compute-tabs),
including same/mixed-language sessions, owner-scoped controls, and measured host
admission. That section owns the current implementation and qualification boundary;
the historical phase-one tests above do not qualify the continuation. Saved-source
semantics, MATLAB figure identity and bounded native artifacts are part of its
cumulative review. Do not delete the older analysis engine merely because a session
or a FIG download works; broader fresh-process parity remains a separate gate.
A connection being verified does not establish
feature parity, cross-platform release readiness, owner acceptance, or a license that
will remain available indefinitely. Phase three is cumulative qualification/delivery
after the bounded implementation and owner review; no release is authorized here.

### Read-only agent inventory

Authenticated provider sessions with `compute:read` may call
`scient_compute_inventory`. Its handler reuses the exact Settings inventory gateway
and shared service instance, with no project/session argument. Provider tool-name
projection and capability-aware instructions use the existing registration seams.
The inventory exposes configured choices, managed status, Toolkit metadata and
existing executable candidates; it is not package verification, a selected running
interpreter, or proof that execution will succeed. It cannot install, execute, attach
to a user session or bypass the later operation-envelope/agent-execution gates.

The linked interaction contract also covers a lightweight ordinary-file entry point,
owned shutdown when its Compute tab closes, and compact actionable recovery instead
of inert Run controls. Setup/repair paths must preserve ordinary Python development
environments and unrelated sessions/processes. These are part of the next pass, not
optional polish after adding tabs; their detailed policy remains in the Foundation ADR.

The subsequent [runnable code-block follow-up](scient-compute-session-foundation.md#follow-up-runnable-code-blocks-in-chat-and-markdown)
records the proposed Run action and inline results for Python/MATLAB in chat and
Markdown. Its scope and gates live in the Compute Foundation ADR, not a duplicate
setup plan. Revisit it after owner acceptance of this pass and the relevant phase-two
session/figure work; it does not expand or block the current phase-one review.

## Why Toolkits are the product unit

Most users want to work with data, create figures, fit a model, or prepare a
lesson. They should not need to choose a collection of low-level package names
before they can express that intent. A **Toolkit** is a reviewed, bounded
capability bundle such as **Data analysis and figures**.

The Toolkit descriptor says what capability Scient can assess. It does not
grant installation authority and does not itself define how packages are
downloaded. Those are separate boundaries:

1. The descriptor names the capability and its minimum compatibility
   requirements.
2. Runtime inspection assesses those requirements against one exact verified
   interpreter.
3. The reviewed managed-environment lock selects exact package versions and
   artifacts; a separate checked manifest pins the installer artifact per
   supported target.
4. A server-owned operation performs explicitly requested setup and returns
   bounded progress plus a durable activation record.

Keeping those boundaries separate allows the same Toolkit concept to describe
an existing `.venv` without pretending Scient installed or owns it.

## Installable vertical slice implemented in this worktree

### Bounded runtime observations

Python verification now observes only the reviewed packages needed by current
compute readiness and the first Toolkit candidate:

- `ipykernel`;
- `jupyter_client`;
- `matplotlib`;
- `numpy`;
- `pandas`; and
- `scipy`.

The probe reads package metadata without importing scientific packages and
runs through the existing isolated interpreter probe. It does not enumerate
the full environment or run `pip freeze`. The observations are transient
inspection data; durable execution identity remains the bounded environment
fingerprint.

### First Toolkit candidate

The first descriptor is **Data analysis and figures**, requiring NumPy,
pandas, SciPy, and Matplotlib. Its current compatibility assessment requires
presence only. Exact minimums should be added only when supported workflows or
the managed lock provide evidence for them.

Toolkit readiness is projected for each exact runtime candidate:

- `ready` means that runtime is compute-ready and has every Toolkit
  requirement;
- `missing-requirement` names scientific requirements absent from that exact
  runtime; and
- `runtime-unavailable` means the interpreter itself cannot run the compute
  bridge, so package presence cannot make the Toolkit usable.

The assessment never combines bridge readiness from one Python with packages
found in another. Older clients and retained test payloads remain decodable
because the new bounded fields default to empty during decoding.

### Transactional managed-environment boundary

The candidate adds one Python-specific manager per Scient server environment.
Its app-owned generations live under:

```text
<computeDir>/environments/python/
```

The environment is shared by projects connected to that server because the
reviewed default Toolkit is immutable and identical for each project. A fresh
setup provisions directly into a new final generation directory. This is
intentional: Python virtual environments embed absolute paths and must not be
built in a temporary location and renamed afterward.

Activation follows this sequence:

1. Serialize managed-environment mutations in the server process.
2. Create one fresh, app-owned generation directory.
3. Ask the concrete provisioner to populate that exact final path.
4. Resolve and contain the returned executable canonically, rejecting lexical
   traversal and symlink escapes.
5. Verify the exact executable and requested Toolkit set.
6. Atomically replace the small active-state record.
7. Name one previous generation for rollback and leave any displaced
   generations in place while this server process may still have sessions
   using them.

Nothing discovers the candidate before step 6. Provision, verification,
cancellation, or activation failure removes only the unpublished candidate and
leaves the previous state untouched. Removal first atomically renames the exact
app-owned environment to a sibling tombstone; deletion failure renames it back.
Removal is refused while a live Python session exists. Removal admission shares
the session-start lock, and new sessions are refused while removal is active.
Startup reconciliation,
after prior-process sessions are gone, removes abandoned app-owned generations
and removal tombstones. A tampered state record cannot redirect inspection or
cleanup outside the managed root.

`repair` deliberately uses the same fresh-generation transaction as install.
It never modifies the active environment in place. The runtime record stores a
relative virtual-environment launcher. Canonical paths are checked for
containment, but Scient invokes the lexical launcher: invoking its resolved
base-Python symlink directly would bypass the virtual environment and its
locked packages.

### Concrete distribution and lock

The first slice pins:

- CPython `3.12.13`, installed and owned inside the fresh generation;
- `uv 0.11.16` as the installer and resolver;
- a universal `uv.lock` plus its exact `pyproject.toml` checksum; and
- the direct scientific set `ipykernel 7.3.0`, `jupyter-client 8.10.0`,
  `matplotlib 3.11.1`, `numpy 2.5.2`, `pandas 3.0.5`, and `scipy 1.18.1`.

Scient does not run a remote shell installer. It downloads the pinned uv
release asset over HTTPS from an explicit host allowlist, checks exact byte
length and SHA-256, extracts it with entry and expanded-size limits, and checks
the reported uv version. Target manifests currently cover macOS arm64/x64,
Linux glibc and musl arm64/x64, and Windows arm64/x64. Listing a target is an
implementation claim, not cross-platform release evidence; every target still
needs packaged-app qualification.

Cancelling a check of the cached installer leaves that cache intact and does
not start a replacement download. A completed check that proves a version
mismatch still discards the invalid cache; a failed replacement download cleans
its staging directory. Cancellation is not evidence of corruption.

Provisioning strips inherited uv, pip, Poetry, pyenv, Conda, and virtualenv
configuration; uses no project or user config; disables source builds and
unreviewed package sources; installs into generation-owned Python, environment,
project, and temporary cache paths; and deletes the cache after a successful or
failed sync. The copied lock and project files remain with the generation as an
audit receipt.

### Product and service surfaces

The generic compute service exposes an optional managed-runtime capability for
a language binding. It does not contain a Python branch. Python supplies the
concrete manager and controller; languages without acquisition support retain
their existing discovery and execution behavior.

Settings and the no-ready-runtime Compute panel use the same status and action
contract. Setup is one explicit click, automatically enables Python, and
selects the verified managed generation for new sessions. Users can switch to
existing runtimes without reinstalling. Update appears only when the pinned
Python, provisioner, or Toolkit revision changes; repair, cancellation, and
private removal remain explicit. Missing managed assets or an unsupported
platform disable only the assisted path, never existing Python compute.

## Intentional boundaries

This slice does not:

- install into or repair a system Python, Homebrew Python, project `.venv`,
  Conda environment, pyenv installation, or any other user-owned runtime;
- accept arbitrary package names, indexes, URLs, commands, or target paths;
- install, update, or switch environments without an explicit user action;
- add a setup questionnaire or required installation to onboarding;
- grant agents software-installation authority or treat a Skill as authority;
- impose Python's acquisition mechanism on R, Julia, MATLAB, or proprietary
  tools; or
- claim Windows, Linux, Intel macOS, remote-host, proxy, or packaged-app
  support before those exact paths are qualified.

Runtime precedence remains explicit: a selected managed generation is
strongest; otherwise a configured executable leads, followed by project
`.venv` and PATH runtimes in their existing order. An installed but unselected
managed generation remains visible last as an option. An explicit per-session
choice is separate from that default and must resolve to the chosen interpreter,
not whichever runtime leads discovery. A failed probe of a selected managed
runtime is reported; an old configured path cannot override a subsequently
selected healthy managed runtime.

Removing the managed installation currently also removes its saved selection.
An existing runtime can therefore become the default again after removal. The
new readiness labels make its scientific-package gaps visible, but whether to
retain a missing managed selection is still a product decision for the next
pass; this candidate does not silently change that policy.

## Accepted decisions and evidence-sensitive edges

### Ownership scope

One shared immutable default environment per server is simpler and avoids
repeating a large identical setup per project. Exact project reproducibility
continues to belong to a project-owned environment selected through the
existing runtime path. If future Toolkits need incompatible dependencies,
that is evidence for multiple reviewed managed profiles or project-specific
environments; it is not a reason to expose arbitrary mutation of this default.

Scient may delete only paths beneath its managed root. The lifecycle never
owns a discovered external runtime.

### Updates and live sessions

Update and repair provision and verify a fresh generation before activation.
New sessions see the selected active generation; existing sessions retain the
executable they started with. Displaced generations are not deleted while the
current server may still host such sessions. Startup reconciliation is their
safe collection point. Explicit removal is blocked while a live Python session
exists.

The file surface compares the live session executable with the default runtime
selected for a new session, only when that default is verified ready. It never
skips an unusable selected managed/configured interpreter to choose a different
ready one. Ordinary Run sends no executable override: the server resolves the
current selection when admitting the new session. The secondary session picker
can still request a different verified interpreter explicitly.

A mismatch offers an explicit switch,
without blocking a deliberately chosen live runtime or silently replacing its
interpreter: confirmation stops the old namespace, retains its transcript, and
the next run starts from the selected runtime. The same surface can force an
exact project-scoped runtime inspection with probe cache bypass, while its
ordinary setup/readiness labels route to Scientific Computing for full
environment management.

Managed operation tracking lives in shared environment-scoped client state, not
in the Settings component. While a compute surface is open, status polls only
during a known operation. Completion, failure, cancellation, selection changes,
and settings changes invalidate runtime inspection for that server, including
project views. Download progress alone does not repeat interpreter probes.
When all surfaces close, polling stops; reopening fetches current state. The
optional status `generationId` distinguishes same-version repairs and reinstalls.
Explicit Refresh also bypasses probe caching and refreshes the managed status.

Settings links retain the originating environment ID. A missing/disconnected
target never falls back to modifying primary-server settings. Opening Settings
from ordinary navigation without an explicit target still uses the primary
environment.

A valid activation receipt whose executable is missing or escapes canonical
containment remains an installed-but-unavailable managed environment. It keeps
its selection and Repair/Remove actions; discovery and verification do not
execute the rejected path. An adapter ownership-inspection failure is an error,
not permission to silently choose system Python. Intentional successful removal
clears the receipt and returns selection to existing-runtime discovery.

Base compute readiness is not Toolkit readiness. The file status and Settings
surface the existing exact-runtime data-and-figures assessment, without
disabling ordinary Python or trying to infer arbitrary dependencies from source
imports. Missing packages remain an explicit managed-setup or user-owned
environment choice. The file-status tooltip identifies the exact interpreter;
missing-module errors link to that server's Python settings without installing
packages or rerunning code automatically.

The active record names one previous generation for rollback. Retaining older
displaced generations until restart is a deliberate reliability tradeoff:
updates and repairs are rare, and temporary disk retention is safer than
breaking an active scientific namespace. If long-lived servers and frequent
profile changes make this unbounded in practice, add explicit session leases
rather than guessing that an old generation is unused.

Provider-runtime helpers are reused only for target detection, bounded HTTPS
download, checksum verification, and safe archive materialization. Python's
generation assembly, lock, virtual-environment launcher, verification, and
session lifetime remain compute-owned because their semantics differ from a
provider CLI archive.

### User and agent authority

Settings and first use are authorized user surfaces. The server resolves the
fixed Toolkit, target, artifacts, and paths; the client never submits a package
or URL. A future agent request must use this same fixed operation envelope and
must have separately accepted user-visible authority. Arbitrary package
installation is a different and much broader capability and must not be
smuggled into the reviewed Toolkit path.

## Implementation sequence and current state

Completed in this candidate:

1. Bounded package observations and exact-runtime Toolkit assessment.
2. Shared ownership decision, pinned uv target manifest, pinned Python, and
   exact universal lock.
3. Transactional provision, cancellation, verification, activation, repair,
   update detection, selection, private removal, and startup reconciliation.
4. Optional generic lifecycle RPCs and client state without a Python branch in
   the shared coordinator.
5. Compact Settings and first-use Compute surfaces preserving existing-runtime
   setup.
6. Exact managed-executable discovery and the unchanged real Jupyter bridge.

Deliberately deferred:

1. Any onboarding pointer, until the ordinary Settings and first-use flow is
   manually accepted.
2. Agent requests, until the operation-envelope authority and receipt model is
   separately accepted.
3. Additional managed Toolkits or languages, until real product demand proves
   their dependency and ownership model.

Notebook authoring and further renderers remain independent tracks under the
accepted compute ADR. This local continuation already includes a stateful MATLAB
binding and bounded table/Plotly results; their acceptance is distinct from
Python acquisition. Managed Python improves first-use reliability; it is not a
prerequisite that blocks those tracks or a replacement for users' existing runtimes.

## Qualification evidence and remaining promotion gates

### Local computer-use pass — 2026-08-31

The isolated macOS candidate was exercised through its actual desktop UI. An
existing managed CPython 3.12.13 ran the prepared NumPy/pandas/SciPy/Matplotlib
fixture successfully. File, cell, and selected-line execution, state retained
after a user-code error, queued cancellation, interruption with namespace
retention, variables, captured PNG/SVG resources, and the shared figure viewer
were checked. An intentionally unavailable configured path disabled new runs;
choosing the already installed managed runtime restored readiness without
restarting Scient. The temporary invalid preference was cleared afterward.

This pass identified and corrected three gaps:

- The file toolbar now wraps at extreme pane widths while preserving minimum
  action widths and the normal single-row layout.
- The shared setup card uses its container width, not the window breakpoint,
  to place actions beside or below its description. Both layout changes were
  visually checked in the isolated app.
- Terminal executions refresh the current lazy workspace tree as well as
  query-backed listings through one environment/project-scoped refresh signal.
  Successful or failed code may have written files. The signal refreshes loaded
  branches and active search without resetting tree state, polling, mounting
  another filesystem watcher, or reloading unsaved editor contents. Subscription
  isolation/cleanup and the actual lazy-tree controller are covered by tests.

The first pass paused before a final visual retest of the file-refresh correction.
The later isolated pass verified automatic file discovery after successful and
failed execution, including under an active matching search, without manual
Refresh. Installer repair/remove/reinstall were not performed through computer
use. A transient file-tree disconnect after development hot reload also
required Retry; normal reconnect behavior remains an explicit qualification
check, not a claimed pass. These limits do not invalidate the automated evidence,
but neither automated tests nor this partial UI pass constitute owner or release
acceptance. Temporary fixtures and screenshots remain in the separately owned
QA directory and are not product assets.

Current local evidence includes:

- schema and typechecking across compute, contracts, client runtime, server,
  and web boundaries;
- exact-runtime Toolkit and bounded package-observation tests;
- manager success, repair-equivalent fresh generations, displaced-generation
  retention, serialization, failure, cancellation, commit, removal rollback,
  tamper, path-containment, and reconciliation tests;
- service tests proving live sessions block removal;
- UI typechecking and focused presentation tests; and
- an opt-in macOS arm64 product test that downloaded the pinned uv asset,
  installed CPython `3.12.13`, synchronized the exact lock, started the real
  bridge, ran pandas/SciPy/Matplotlib through a real kernel, retained rich
  output, blocked unsafe removal, and removed the private environment. The
  observed clean setup-to-removal test completed in about 45 seconds on the
  qualification host.

Before release promotion, still require:

- review of artifact provenance, package/distribution licenses, notices, and
  the update process that regenerates every checked hash;
- exact packaged-app staging and installation evidence;
- macOS Intel, Windows arm64/x64, Linux glibc/musl arm64/x64, remote-host,
  proxy/custom-certificate, offline, low-disk, cancellation, interrupted
  process, and restart qualification;
- manual Settings and first-use UX acceptance, including update, repair,
  switching, failure copy, and accessibility;
- full current-main CI plus final formatting, seam, dependency-boundary, and
  diff review; and
- a release decision that records any unsupported target instead of silently
  advertising it.

This worktree is ready for local owner testing only after those local checks
finish. It is not, by itself, evidence for cross-platform release readiness.
