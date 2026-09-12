# Diagrams in chat

Scient turns a completed `mermaid` Markdown fence into an inline diagram. This
works well for research workflows, architectures, timelines, state changes,
entity relationships, and other explanations where the connections matter.
The same rendering is available for Mermaid fences in Markdown file previews.
Ask the AI to make a Mermaid diagram when a process, hierarchy, or relationship
would be easier to understand visually than as a list of steps.

The diagram card lets you:

- expand and zoom the diagram;
- show or copy its Mermaid source;
- download a scalable SVG;
- copy or download a high-resolution PNG;
- retry or read the original source if the diagram is malformed;
- in chat, choose **Ask agent to fix** beside the error to add a citation
  capsule to your composer. It includes the diagram and renderer error; use the
  capsule's pencil to edit the repair request, or remove it with its close icon.
  Review the request, then send it. This does not send
  automatically or change the original answer; the agent replies with a correction;
- use **Copy error and source** if you prefer to paste the request elsewhere
  or while reviewing a Markdown file. Its icon sits beside the error, along with
  **Retry diagram**.

For a rendered diagram, quiet **Expand** and **More** icons sit at the top-right.
Any authored title remains visible; **More diagram actions** identifies the diagram and its type,
and contains source, copy, and download actions. Source inspection opens
on request. A failed diagram instead shows its error directly above a normal
code block, with its language or title, syntax highlighting, copy, and line-wrap
controls. Expanded viewers keep zoom, fit, and actual-size controls visible.

In an editable Markdown file, the source box below a diagram error is already
an editor. Click anywhere in its text and type there; the box stays in place.
The diagram updates as you fix the source. Escape returns to the document, and
the same source box remains visible while the error persists. Read mode keeps
the source selectable for copying.

Choose **Move controls** in More to expose a movement handle. Drag it or use
arrow keys to move within the card; press Enter or Escape to finish.
**Reset controls position** restores the default placement.

While an answer is still being written, Scient shows the Mermaid source as an
ordinary code block. Rendering begins only after the answer settles and the
diagram is close to the visible conversation. A bad or unsupported diagram
never makes the rest of the answer disappear.

For supported syntax mistakes—such as unquoted labels, misplaced separators,
the common pie dash separator, quadrant coordinate parentheses, or a known
command typo—Scient tries a local recovery before showing an error.
Compatible fixes are tested together; if the diagram still
cannot render, you get the original source and error with the usual repair
actions. It never calls an AI automatically or guesses missing diagram content.
A recovered diagram's More menu offers **Copy recovered source** and **Copy
original source**. Source inspection and editing still show the original text;
neither the conversation nor a Markdown file is silently rewritten.
Missing connections, ambiguous brackets, and incomplete diagram blocks still
show an error rather than a guessed diagram. Recovery works in both chat and
Markdown side-panel previews; it needs no extra click.

The Mermaid source remains the original content in the conversation. Copying
the whole answer preserves a fenced `mermaid` block, so it remains readable
where an interactive diagram is unavailable. Rendering and image export happen
locally; Scient does not send diagram source to a rendering service.

Rendering is local and restricted: source callbacks and remote asset loaders
are not activated. Very large diagrams are rejected instead of slowing the
whole conversation.

An inline diagram is not automatically saved as a project file. Ask the agent
to create a real `.mmd`, SVG, or other project artifact when you need something
durable and editable outside the conversation.
