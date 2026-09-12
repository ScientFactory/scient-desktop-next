# Scientific computing

Scient can run Python and MATLAB from an initialized project without turning the project into a
notebook or installing a second copy of its files. Both use the same session, source, results, and
history controls. Each language remains optional; MATLAB requires a user-installed, licensed
runtime and a compatible Engine host. See [Run a MATLAB file](matlab-run-file.md) for its setup and
the separate fresh-process workflow.

## Set up a runtime

The quickest path is **Set up Python** in the Compute panel or under
**Settings → Scientific Computing**. Scient downloads a verified installer and creates one private,
shared Python environment for that Scient server. It includes a reviewed, locked data-and-figures
Toolkit with NumPy, pandas, SciPy, Matplotlib, Jupyter Client, and ipykernel. Setup also enables
Python and selects that exact environment for new sessions.

The managed environment is optional. To use Python you already maintain instead:

1. Open **Settings → Scientific Computing** for the server environment you want to use.
2. Enable Python.
3. Choose **Use** beside an installation, or **Use another installation…** to enter its executable path.
   **Reset to automatic** restores discovery instead of pinning an installation.
4. Choose **Refresh** to find existing installations, then the small **Test** action to check one.
   A ready Python needs CPython 3.10 or newer,
   `jupyter_client` 8.6 or newer, and `ipykernel` 6.29 or newer. Install missing requirements with
   your own environment tooling, then verify again.

Prefer a project `.venv` or another virtual environment you control. Scient detects a project's
`.venv` when that project is open. The isolated compute bridge does not load packages installed
with `pip --user`; do not force packages into a Homebrew- or system-managed Python merely to make
runtime discovery succeed.

The settings inventory is environment-wide. When a project is open, its Compute panel also checks
that project's `.venv`. A configured interpreter that is missing or unusable remains visible as a
problem; Scient does not silently replace it with another interpreter.

Each language has one card, with a separate expandable row for each installation. **Default**
identifies the preferred installation for new sessions, not an interpreter already running.
**Details** reveals that installation's path, copy action, test diagnostics, and applicable
maintenance controls. Python and MATLAB enablement applies to the language, not just one row.

**Use** changes only which runtime new sessions prefer. Choosing an existing Python also releases
Scient-managed precedence; it does not copy or modify packages. **Repair** builds and verifies a fresh managed generation before activating it;
an existing generation remains available if setup fails. **Update** appears only when Scient ships
a newer reviewed Python or Toolkit revision. **Remove** deletes only Scient's private environment
and is refused while a live Python session may still be using it. Project `.venv`, configured,
system, Homebrew, Conda, pyenv, and other user-owned installations are never repaired or removed.

The Python status in a file header opens **Scientific Computing** whether it says **Set up Python**
or **Python ready**. Its adjacent refresh action rechecks that exact project and bypasses the short
runtime-probe cache, so an installation or environment change can be recognized without reloading
the app. Scient never swaps the interpreter beneath a live session. If the selected Python changes
while a session is open, the header offers **Switch Python**; confirmation stops the old namespace,
keeps its run history, and lets the next run start with the newly selected environment.

Setup, repair, removal, and runtime-selection changes update open compute views automatically,
even if you leave Settings before setup finishes. Use refresh when Python or its packages changed
outside Scient. Settings opened from a project always manages that project's server.

If a selected managed installation is damaged, Scient keeps it visible for **Repair** rather than
quietly running your code with a different Python. You can explicitly choose an existing environment
instead. Removing the managed installation intentionally returns new sessions to existing-runtime
discovery; it does not remove your other Python installations.

An existing Python can run ordinary code without every scientific library. If the reviewed
data-and-figures packages are missing, the header says **Python packages missing** and the installation's
**Details** names them after a test. **Test passed** confirms the connection, not that every optional
library is installed. Run remains available for code that does not need those packages; Scient does not
silently install them into a user-owned environment.
Hover over the file's Python status to see which interpreter it refers to. A missing-module error
also offers **Python environments**, taking you to the right server's settings. After choosing or
repairing an environment, rerun the code yourself; Scient never replays a failed run automatically.

## Connect your MATLAB installation

Open **Settings → Scientific Computing** for the project's server and enable MATLAB.
Choose **Use** beside the installation you want, or leave automatic discovery selected.
The same executable preference is used by live Compute sessions and fresh-process
MATLAB runs. Existing preferences are respected; saving a new choice or clearing it
does not reintroduce an older path.

Opening Settings and **Refresh** only look for installations and read their metadata; they do not
import MATLAB Engine or start Python/MATLAB. Recent status stays visible while being rechecked.
An installation appearing in the list does not promise that the Engine works or a license is available. **Test** checks the Engine host, starts
and closes a real, temporary MATLAB session without executing project code or creating
run history. Verification is an observation, not a permanent license guarantee; refresh
or a runtime change clears it. A license/startup failure stays visible with recovery guidance.

If an Engine host is missing, **Set up connection** in the selected installation's **Details** installs a small
private Python helper for your selected MATLAB, then checks its Engine import. It does
not install MATLAB, activate a license, or install the scientific Python Toolkit. Choose
**Test** afterward to check native startup. Assisted setup currently accepts
MATLAB R2024b–R2026a; other releases may use an existing compatible Engine host. You still
need MATLAB installed and licensed on the server where the code runs.

The helper's controls stay with the MATLAB installation it was built for. Selecting another
MATLAB does not move those controls or pretend the helper already matches it; **Set up connection**
can prepare a replacement for the new default.

**Use existing host** returns to compatible Python hosts you maintain. **Repair connection** prepares a
fresh private helper for the selected MATLAB and activates it only after verification.
Use it after changing your MATLAB installation. **Remove helper** removes only this helper, never
MATLAB, its license, your projects, or Scientific Python. Removal is blocked while a live
MATLAB Compute session uses the language. A broken selected helper is reported instead
of silently choosing another Python host. Setup and repair can be cancelled.

The helper and Scientific Python are independent: installing, selecting, repairing, or
removing one does not select or remove the other. No MATLAB-to-Python translation or
automatic Octave fallback takes place.

## Run code and view results

Open a `.py` file in the ordinary project editor. Its header offers three views:

- **Code** gives the editor the full surface.
- **Split** keeps code and the selected run's results side by side.
- **Results** gives text, errors, and figures the full surface.

The contextual **Run** action executes exact selected text when one exists, otherwise the explicit
`# %%` cell containing the caret, and otherwise the whole current buffer. Cmd/Ctrl+Enter uses the
same rule. Its menu also provides the explicit actions:

- **Selection** runs the exact selected text (the existing gutter line selection also remains
  available).
- **Cell** runs the current `# %%` cell without its marker lines.
- **File** runs the exact current editor buffer.

Files without explicit `# %%` markers remain ordinary files; Scient does not invent notebook cells.
In a marked file, placing the caret inside a cell gives the code that would run a quiet active
background and a gutter run action while normal caret placement and editing continue to work.
Selecting text removes the cell treatment because the exact selection becomes the run target;
moving the pointer alone never changes the active cell.

MATLAB `.m` files use the same controls with MATLAB `%%` sections instead of Python cell markers.

The first run starts a ready project session when necessary and changes the file to **Split**, so
the result appears beside the source that produced it. A project has at most one live session.
Values defined by one successful execution are available to later executions until you restart or
stop the session.

Running an unsaved buffer does not save it. History records the exact submitted code and its saved
base revision, and labels the run as unsaved. A saved submission is accepted only when its
recorded revision and source range still match the project file.

## Control and review a session

- **Cancel** removes queued work or requests cancellation of the named execution.
- **Interrupt** stops active work while preserving the namespace when the runtime succeeds.
- **Restart** creates a new namespace generation and clears in-memory state.
- **Stop** ends the live runtime but keeps its transcript.

The results surface shows one selected run rather than an ever-growing feed. Its compact history
selector lets you revisit earlier runs of the same file. Static PNG and SVG figures emitted with
normal display behavior such as `plt.show()` or IPython's `display(...)` appear inline at a useful
size and open in Scient's existing full static-image viewer when selected. A compact action on each
figure moves it into the shared movable, resizable floating viewer. Moving a figure between the full
and floating viewers preserves one presentation owner rather than showing two copies; closing that
viewer stops its updates and later runs never reopen it.

A viewer opened from the current result can follow a generated project figure by its project path,
or a runtime figure by its language, saved full-file source path, and figure position. It advances
only after a newer matching run succeeds. Failed, cancelled, interrupted, or lost runs keep the last
good image. A successful full-file run that omits a followed runtime figure keeps the prior image
labelled **Previous figure**. New bytes are decoded before replacing the visible image, while an
identical-content rerun renews its retained resource without resetting zoom. Figures from a cell,
selection, unsaved buffer, historical run, or output without stable provenance remain immutable
snapshots.

PNG and SVG project files created or changed by that execution also appear inline, so an ordinary
script that saves figures remains useful without notebook-only display calls. Discovery is bounded
and reports when a project or execution exceeds its safety limits; Scient never guesses figure paths
from printed console text.

While the newest run is still updating, its text and status remain current but Results keeps the
last successful figures from the same file and session generation visible. The figures are labelled
as previous and link back to the run that produced them. The same continuity remains after a failed,
cancelled, or lost run; it clears immediately when the new run produces figures or succeeds without
any.

The selected run's result is shown immediately. The file results surface does not repeat the full
submitted code beside the editor; it shows only whether the run used the file, a selection, or a
cell, the relevant line range, and whether the submitted buffer was unsaved. Scient still retains
the exact submitted bytes as durable provenance. If a saved file has changed since the selected run,
the same compact context says **Source changed** without exposing a revision hash.

A normal successful file run shows its figures and text directly, without another large card that
only says **File**. If one run produces several figures, they appear as peer result cards in the same
run. Compact context remains visible when it matters, such as for a selection, cell, unsaved buffer,
running execution, or failure. The separate Compute history keeps source labels because it can span
multiple files.

The separate **Compute** project surface is secondary: use it to inspect sessions and history that
are not tied to the file currently open, or to restart, interrupt, and stop the live session. It is
not a second editor and has no generic code composer.

Supported scalar tables appear as bounded previews, and Plotly outputs use Scient's existing
interactive chart viewer. A **Limited preview** label identifies clipped tables; this is not a
full dataset browser. Unsupported or malformed rich output retains its available plain-text
fallback. Viewing results does not enable executable HTML or widgets.

The secondary **Variables** view describes the current live Python namespace with bounded names,
types, shapes or sizes, and safe previews for simple values. It refreshes after a run finishes,
including a failed run because assignments before the exception may remain. It is not saved in run
history, cannot be attached to an older session, and clears when the session restarts. Unsupported
objects remain visible by name and type without asking them to generate an arbitrary representation.

While code is running, **Interrupt** cancels that execution but keeps variables already stored in the
session. The session actions menu contains **Restart session**, which clears Python variables while
keeping history, and **Stop session**, which closes the kernel while keeping history. Restart and stop
ask for confirmation because their in-memory state cannot be recovered.

Past sessions retain their exact submitted code, text output, errors, tracebacks, and static figures.
Reopening a result never starts a kernel or replays code. Source links in the separate Compute
surface return to the ordinary project editor. Python errors keep their full bounded traceback and
show project-local frames as source links; dependency and standard-library frames stay readable but
cannot become filesystem links. Files created by code are ordinary project files;
writing an SVG or PNG during an execution also snapshots that static figure into the retained result.
Changing the project file later does not rewrite what the earlier run displayed. Other generated
file types remain ordinary project files and are not inferred from their names or printed paths.
Retained compute history is operational data, not a second project filesystem or a portable result
package.

Scientific code runs with the filesystem and network authority of the selected Scient server
environment. It is not sandboxed. Only run code you trust, especially when the server is remote.

Python is disabled by default until a user enables it or explicitly starts managed setup. R, Julia,
arbitrary package installation, notebook editing, rich executable HTML/widgets, rich variable
drill-down/table browsing, and portable stateful compute-result promotion remain future work.
MATLAB's existing fresh-process **Run file** workflow remains separate from a stateful compute
session and already offers its own **Save to project** action.
