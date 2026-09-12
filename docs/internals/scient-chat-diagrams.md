# Scient rich chat diagrams

Status: implemented on top of the chat-math foundation; Mermaid source remains
canonical chat Markdown.

## Product and ownership boundary

Scient owns `apps/web/src/scient/diagrams`: the lazy Mermaid runtime, inline
card, expanded viewer, export helpers, styles, and tests. The inherited T3 host
has one renderer seam in `ChatMarkdown.tsx`: a settled fence whose language is
`mermaid` is passed to `MermaidDiagramCard`. Streaming and every other code
fence continue through T3's existing code-block path. A static seam audit keeps
that integration narrow during upstream refreshes. Because Markdown file
previews already share `ChatMarkdown`, they receive the same behavior without a
second viewer integration.

There is no wire-format, database, attachment, artifact-store, or Markdown AST
fork. The source already present in the assistant message is authoritative;
SVG and PNG are disposable local representations. This is intentionally the
first presentation layer for the future Scientific Artifact Studio, not a
second artifact model. A future “save as artifact” action should follow the
[Scientific Artifact Studio roadmap](./scientific-artifact-studio.md) and its
typed artifact-reference boundary rather than adding persistence to the
diagram card.

## Rendering pipeline

The exact-pinned `mermaid` 12.0.0 package is locally bundled and dynamically
imported only when a settled diagram enters a 400 px viewport margin. The
initial chat bundle does not import Mermaid. Rendering is serialized because
Mermaid configuration is process-global. Identical source/appearance renders
are deduplicated in flight and cached in a bounded LRU (100 entries / 20 MiB).
Scient explicitly retains `layout: dagre`, `look: classic`, and its light/dark
themes instead of adopting Mermaid 12's new visual defaults. Authors can opt
into supported layouts/looks in Mermaid frontmatter. Mermaid 12 targets modern
ES2024 browsers; the desktop Electron runtime meets that requirement.

Cached SVG contains marker, mask, link, style, and accessibility ids. Every
consumer receives a rebased copy with unique ids and rewritten fragment and
ARIA references, so duplicate diagrams do not target one another's SVG
definitions. The card uses `content-visibility` and an intrinsic placeholder
to keep long conversations cheap.

The runtime accepts the full Mermaid package rather than a reduced grammar so
scientific explanations can use flowcharts, sequence/state/entity diagrams,
mindmaps, architecture diagrams, Gantt/timeline diagrams, and Mermaid's math
labels. Source is capped at 50,000 characters and graphs at 500 edges. Mermaid
runs with `startOnLoad: false`, strict mode, suppressed error diagrams, and the
current light/dark appearance. The app inserts only Mermaid's sanitized SVG
and deliberately does not call `bindFunctions`, so source-authored callbacks
do not run. No remote renderer, CDN, custom icon pack, or remote asset loader is
registered.

## UX and recovery

After a recognized syntax failure, the runtime may attempt one local recovery
render. `mermaidRecovery.ts` proposes exact UTF-16 edits against the original
source. The supported rules are deliberately family-specific:

- Explicit diagram declaration/direction casing and header comment placement;
  no inferred diagram family or direction.
- Literal flowchart label quoting (including nested parentheses and literal
  quotes), short/dotted link tokens, and explicit subgraph ID/title delimiters.
  The scanner supports parallel nodes, named edges and semicolon-separated
  statements while leaving unrelated multiline labels and modern node data alone.
- A missing square closer immediately after a complete quoted label and before
  an explicit link. Bare unclosed labels and mismatched shapes are not guessed.
- Sequence message/note separators with explicitly declared participants,
  including full-width colons at that boundary only.
- Pie label quoting/separators (including the common quoted-label dash typo),
  literal XY/quadrant chart label quoting, and the narrow quadrant coordinate
  delimiter repair from `(x, y)` to `[x, y]`, without changing values or chart
  data.
- The exact C4 `Persons(...)` command typo is corrected to `Person(...)`;
  other C4 commands and identifiers remain opaque.
- Top-level class/state short arrows, accessibility metadata placement in
  supported families, and a small command-position Git graph typo allowlist.

`mermaidRecoverySyntax.ts` retains original UTF-16 offsets and protects comments,
frontmatter, directives, rich labels, accessibility prose and class/state bodies.
Unsupported spans do not prevent independent safe repairs elsewhere. It never
invents nodes, targets, cardinalities, values or missing block endings. Numeric
suffixes are bounded before matching to avoid pathological backtracking.

All compatible edits form **one candidate**, capped at 256 edits and the existing
source limit. Intermediate candidates are never published. Original rendering
must fail first; a successful original bypasses recovery entirely. Only a full
native render accepts the candidate. Any remaining syntax, layout or rendering
failure discards it and exposes the original diagnostic and source through the
existing error UI. Resource/loading failures do not trigger syntax recovery.
Original and recovery rendering share one serialized operation; successful
recovery provenance is cached with the SVG under the original source/theme key.

This is a disposable rendering projection, not a chat or document correction.
The menu identifies recovered diagrams and offers **Copy recovered source**,
separately from **Copy original source**. Source inspection, the document-owned
source editor, context-menu source copy, whole-answer copy and citation identity
retain the original. Opening a recovered preview cannot create an editor
transaction or save a file. No agent invocation, extra validation tool, or
layout-changing recovery notice is added.

The settled card has explicit loading, ready, source, and error states. A parse
failure shows one compact error line with adjacent repair, copy, and retry icons.
The failed diagram has no separate toolbar or diagram menu. Its source sits
directly below, using the same `MarkdownCodeBlock` as ordinary chat fences:
language/title header, highlighting, source copy, and line wrapping. The shared
block has no extra outer margin in this slot. Editable Markdown files retain
their mounted source editor instead. Successful diagrams keep their existing
toolbar, viewer, and export actions. A diagram failure does not prevent the
surrounding Markdown from rendering. In chat, **Ask agent to fix** uses the
existing `ComposerHandleContext.citeAssistantText` API to insert a reviewable
`AssistantCitationChip` at the caret, using the same serialization, editable
comment, removal, and provider expansion as selected-text citations,
preserving the draft and attachments and respecting the composer's busy state.
Insertion owns deferred focus: an immediate extra focus call would publish the
editor's previous snapshot before its controlled update. It does not submit or
mutate a past message. The containing `AssistantCitationSource` provides the
actual message/thread identity. Shared range capture quotes the displayed source
without changing native selection; if the source cannot be captured, it quotes
the visible error and includes the full source in the comment instead. No source
offsets are invented. Prefilled repair citations do not automatically open a comment popup.
The existing 8,000-character quote/comment limits remain; oversized contexts are
not silently truncated and can still be copied. **Copy error and source** provides
the same request when no composer is available. Requests include the Mermaid source,
package version and parser diagnostic (bounded to 8,000 characters, without its
stack); nested Markdown fences are escaped by the shared export helper.
Only results matching the current source, theme and retry generation may be
displayed or used for repair. Pending edits keep the error source editor mounted,
but replace obsolete diagnostics with a single-line pending label and disable
repair until the new result arrives. Copy success uses an icon checkmark and a
screen-reader announcement, not a layout-changing message row. Action failures
use the shared error notification. The Markdown editor's isolated node-view
roots do not receive the chat composer context; they retain source editing and
the copy action rather than offering a nonfunctional repair action.

The expanded dialog supports fit, 25-400% zoom, actual-size layout,
two-dimensional scrolling, source copy, and
the same SVG/PNG export actions as the compact card. SVG download adds
standalone namespaces and an appearance background. PNG copy/download
rasterizes the same SVG at up to 2x, bounded to 8192 px per dimension.

Export preparation parses Mermaid's sanitized HTML-compatible output in an inert
template and serializes it as XML. This preserves XHTML/MathML namespaces and
HTML line breaks without changing the Mermaid source or on-screen rendering.
PNG conversion assigns an intrinsic viewport and uses the shared
`loadCanvasImage` helper: SVG bytes become a self-contained data URL because
blob-backed HTML labels can taint the canvas. The regular image viewer uses the
same decoder; its authorized asset fetch and original-file download are unchanged.
Raster formats retain object URLs, which are released after decoding. No remote
renderer or relaxed browser security is required. SVG remains vector content;
external editors still need support for its HTML labels.

The inline card uses the renderer-independent `VisualCardToolbar` shared with
workspace images and interactive charts. It removes the full-width header bar
and reduces stage padding; the controls' default slot stays above the diagram.
Dragging the dotted corner or empty toolbar space translates only the toolbar
within the card, leaving action buttons unchanged. The shared
movement lifecycle is documented in [chat images](scient-chat-images.md).
An authored fence title stays visible, while the generic label and diagram type
remain available in the menu. SVG sizing, lazy rendering, export, and the
expanded dialog retain their existing behavior.

`data-markdown-copy` carries a complete fenced source block, so selection and
whole-message copy never serialize the generated SVG. Individual source-copy
uses the untouched diagram text. Fence title metadata becomes the visible
title and a portable export filename.

## Agent capability discovery

Agents do not infer renderer capabilities from the UI. Scient's compact shared
awareness contract names Mermaid, places the diagram declaration before its
contents (not necessarily before valid frontmatter/comments), and distinguishes
inline representation from a durable artifact. Provider delivery and capability gating are governed centrally by
[the provider architecture](./providers.md#scient-awareness); the diagram
renderer does not inject hidden user text or project instruction files.

## Platforms and fallback

Desktop and web use the rich card. Mobile's native Markdown stack is unchanged,
so a Mermaid fence remains a readable source code block there. Older clients,
exports, and external Markdown readers get the same fallback. This progressive
representation is why no protocol negotiation or message migration is needed.

## Verification and upstream maintenance

`pnpm --dir apps/desktop test:svg-export` exercises actual Chromium serialization,
image decoding, PNG download/copy, and saved-SVG copying across the diagram corpus
in both themes. CI runs it under Xvfb. It checks label painting, namespace and ID
preservation, bounded output, and non-interactive image security. The test uses a
temporary profile and captures output bytes without touching the user's clipboard.
DOM mocks alone cannot establish these properties.

Co-located unit tests cover source bounds, declaration-first parsing with
accessibility metadata, SVG id/reference rebasing, portable
filenames, standalone export preparation, Markdown round-tripping, and the
single `ChatMarkdown` seam. Server tests assert the shared awareness contract,
its capability gate, and every built-in provider delivery decision. The production build is the bundle
gate: Mermaid must remain in lazy chunks rather than the entry bundle.
`docs/fixtures/scient-chat-diagrams.md` is the manual light/dark corpus for the
major diagram families, math labels, RTL/Unicode, duplicates, export, copy, and
recovery states.
Mounted interaction tests cover review-before-send, draft preservation, repeated
clicks, missing composer/clipboard and stale asynchronous results. Run
`pnpm --dir apps/desktop test:mermaid-render` for a hidden Chromium test of the
actual renderer, both themes, full diagnostics and 48 concurrent cache consumers.
The same check exercises the recovery corpus, the user's mixed valid/broken
regression corpus, combined fixes, refused ambiguous
input, semantic label/value preservation, and bounded scanning; unit tests cover
atomic rollback, source/theme cache separation, stale results, and original-source
copy/editor ownership. Fixtures describe specific qualified cases, not a general
guarantee that arbitrary malformed Mermaid can be repaired without guessing.
It uses only the synthetic fixture corpus and a disposable profile, without
visual automation or provider calls. On Linux, run it under `xvfb-run`.

Upgrade qualification also reproduced two **pre-existing export limitations**
on 11.16.1 and 12.0.0: HTML line breaks can produce invalid standalone SVG XML,
and PNG export of HTML-label (`foreignObject`) diagrams can fail with a tainted
canvas. The smoke report lists these separately and detects changes from the
pre-upgrade export baseline; a passing renderer check is not an export-success
claim. Fix canonical SVG serialization and browser rasterization in a separate
targeted export pass. Do not rewrite authors' Mermaid source to conceal these
representation-layer failures.

When T3 changes `ChatMarkdown.tsx`, reapply only the import and settled-fence
branch, then rerun the diagram seam test. When T3 adds equivalent rich Mermaid
support, prefer retiring this seam and adapting Scient's export/accessibility
UX around the upstream renderer rather than maintaining two renderers.
