# Run a MATLAB file

Use Scient's MATLAB panel to run a project analysis, inspect its output and
figures, and save useful results beside the rest of the project. Scient can
always open and edit a `.m` file. Running it additionally requires a
user-installed and licensed MATLAB in the selected project environment.

## Live session

The code/results controls above a `.m` file run it in a live MATLAB session.
Enable MATLAB and check its runtime in **Settings → Scientific Computing**.
The Engine connection requires a compatible Python host. Settings can set up a
small private **MATLAB connection helper**, or use an existing compatible host.
Scient does not install MATLAB or its license. **MATLAB ready** and **Set up MATLAB** both open those
settings, and the nearby refresh action checks detection again.

In Settings, **Detected** means the Engine import is available; **Verify connection**
starts and closes a temporary native MATLAB session to check the license and startup.
The executable preference is shared with fresh-process runs. Their older setup control
now writes this same preference instead of maintaining a second runtime choice.
See [Connect your MATLAB installation](scientific-computing.md#connect-your-matlab-installation)
for setup, repair, removal, and the distinction between the helper and MATLAB itself.

On macOS, MATLAB may check its usual Documents folder during startup. If macOS
asks whether Scient can access Documents, answer that permission prompt before
retrying the session. Scient does not grant operating-system permissions for you.

Use **Run file**, **Run selection**, or **Run cell** for `%%` sections. Variables
remain available between runs until the session stops or restarts. Results and
Variables share the same panel used by Python. Running code is not sandboxed.

For saved-file batch execution and portable run artifacts, expand
**Fresh-process MATLAB runs** below the file. This is the existing workflow:

## Fresh-process file run

1. Open an initialized Scient project and select a text `.m` file.
2. Wait for any pending save to finish. Scient runs the exact saved version,
   not an unsaved editor buffer.
3. If MATLAB was not found, choose **Set up MATLAB**, enter the path to the
   MATLAB executable, and choose **Use path**. You can also ask Scient to scan
   again.
4. Use **Verify** when you want to confirm that MATLAB can start or understand
   a setup failure. Scient reports the detected release and explains problems
   such as sign-in, licensing, a missing dependency, startup failure, or a
   timeout.
5. Choose **Run file**. Standard output, errors, status, figures, and the
   file's recent run history appear in the panel.
6. If another MATLAB run is active, the new run waits in the queue and shows
   its position. **Stop** cancels a waiting run or stops the active run.
7. Select a captured figure to inspect it as a static view or floating card.
   You can drag a thumbnail into the conversation, resize the floating card,
   or download its FIG representation for continued work in MATLAB.
8. Choose **Save to project** when a useful run should become an ordinary
   project result. Scient creates a folder under
   `results/<source>/<run>/` containing readable output, figures, continuation
   files, notes, and a machine-readable manifest. Repeating the action reopens
   the same result without overwriting your edits.

Use **Remove this run** to remove one saved run, or **Clean up project** to
review and remove saved run files that are no longer needed. Scient confirms
the measured size before cleanup and keeps a lightweight history of what ran.

On macOS, a typical executable is
`/Applications/MATLAB_R2025b.app/bin/matlab`. Windows and Linux paths depend
on the installed release. Scient does not bundle MATLAB or provide a license.

## Understand results and failures

Viewing and editing a `.m` file never starts MATLAB. A missing or invalid
runtime is a setup state, not a file-viewer failure. A folder opened without
Scient project setup remains editable, but **Run file** stays disabled until
the folder is set up.

When MATLAB reports an `MException`, Scient separates the structured error
from raw output. Select a project-local file and line to open it, or choose
**Ask agent** to place a focused repair request in the composer for review
before sending.

If another program or an agent changes the open file, Scient refreshes it.
When you have unsaved edits, it asks whether to reload the disk version or
overwrite it instead of silently discarding either version. Figure-capture
failure is reported separately from calculation failure, and long output shows
an explicit truncation notice.

The fresh-process workflow runs a complete `.m` file in noninteractive batch
mode, independently of a live Compute session. Neither workflow adds debugging,
MATLAB notebooks, or viewers for `.mlx` and `.mat` files. Use **Verify** in each
environment to confirm that its installed MATLAB
version, architecture, license, and dependencies are ready before relying on a
run.
