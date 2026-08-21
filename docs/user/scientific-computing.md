# Scientific computing

Status: candidate behavior under review; not yet a released Scient capability.

Scient can run Python from an initialized project without turning the project into a notebook or
installing a second copy of its files. Python is the first supported stateful runtime; the compute
contracts and settings are language-neutral so later languages can remain independently optional.

## Set up a runtime

1. Open **Settings → Scientific Computing** for the server environment you want to use.
2. Enable Python. This enables discovery only: Scient does not download Python, install packages,
   create an environment, accept a license, or change the selected interpreter.
3. Leave the executable on **Automatic**, or enter an interpreter path when you want to pin one.
4. Choose **Refresh** to inspect existing runtimes. A ready Python needs CPython 3.10 or newer,
   `jupyter_client` 8.6 or newer, and `ipykernel` 6.29 or newer. Install missing requirements with
   your own environment tooling, then refresh again.

The settings inventory is environment-wide. When a project is open, its Compute panel also checks
that project's `.venv`. A configured interpreter that is missing or unusable remains visible as a
problem; Scient does not silently replace it with another interpreter.

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
size and open in Scient's existing full static-image viewer when selected. PNG and SVG project
files created or changed by that execution also appear inline, so an ordinary script that saves
figures remains useful without notebook-only display calls. Discovery is bounded and reports when
a project or execution exceeds its safety limits; Scient never guesses figure paths from printed
console text.

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

Python is disabled by default. R, Julia, MATLAB stateful sessions, package management, notebook
editing, rich executable HTML/widgets, rich variable drill-down/table browsing, and portable
compute-result promotion remain future work. MATLAB's existing isolated **Run file** workflow is
separate from a stateful compute session.
