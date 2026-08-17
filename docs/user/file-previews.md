# File previews

Scient opens files linked in chat inside Scient first. Project files keep their
editable Files-panel behavior. Files elsewhere in the connected environment
open in a read-only side panel or, for HTML, the integrated browser.

In a project file's header, select the project name or any parent folder to
browse that folder, drill into its subfolders, and open a nearby file. The final
file name identifies the current file and is not a navigation control.

Right-click a file tab to copy either its project-relative path or its full path.
For a remote project, the full path belongs to the connected environment rather
than the computer displaying Scient.

- Markdown files open as rendered documents. Use the source/preview control in
  the file header to switch modes; Scient remembers that preference. A link to
  a specific Markdown line opens source so the requested line can be shown.
- Text files larger than the preview limit open read-only. In rendered
  Markdown, task checkboxes are also non-interactive so a partial preview can
  never replace the complete file.
- HTML files open in the integrated browser. To edit the HTML, right-click the
  file in the file tree and choose **Open source**.
- If the integrated browser is unavailable or an HTML preview fails, Scient
  opens the source instead.

Direct files outside the current project support:

- images, including SVG, with pan and zoom;
- PDFs in the full Scient reader, including remembered reading state;
- rendered Markdown, including math, Mermaid diagrams, and Vega-Lite charts;
- syntax-highlighted source and text, including TSX, Python, MATLAB, R, JSON,
  CSV, and LaTeX source;
- browser-supported audio and video; and
- a stable file-information view for formats that do not yet have a rich
  renderer. On the primary desktop environment, the header can still open the
  file in a preferred editor.

Text previews are read-only and bounded to 2 MiB. Large files show that limit
explicitly. An optional line target is revealed once after the source view is
ready.

HTML runs normally in Scient's integrated browser, including JavaScript,
network requests, navigation, and relative local CSS, scripts, fonts, data,
images, and media. A packaged site that assumes it is hosted at a web-server
root (for example, references `/assets/app.js`) should be opened through its
development or static server; a standalone local document should use relative
asset paths.

"In the connected environment" is important for remote sessions: an absolute
path refers to the remote host, not the desktop Mac or PC. Remote files can be
previewed through Scient, but desktop-only editor actions are not shown.
