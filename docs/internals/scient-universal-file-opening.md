# Scient universal file opening

## Product contract

A primary click on a file link in chat opens the file inside Scient first.
Workspace files retain the inherited editable Files panel. An absolute file
outside that workspace receives a durable Scient right-panel surface, except
HTML, which opens in the existing integrated Browser because Browser already
owns navigation and executable page state. The context menu retains explicit
editor and Browser actions.

The result is universal routing, not a claim that every binary format already
has a bespoke renderer. Every valid regular file has a useful in-app outcome:
a rich adapter when one exists and a minimalist metadata/fallback surface when
one does not. Generated chat images and analysis artifacts keep their existing
specialized cards and panels; this feature does not regress or redirect them.

## Environment authority and preparation

`filesystem.prepareFileOpen` is the single inspection boundary. The connected
server, not the browser UI, interprets the path. It requires an absolute path,
resolves symlinks to a canonical regular file, reads at most 64 KiB for
classification, and returns only serializable presentation metadata. Missing,
directory, unreadable, and inspection failures remain typed RPC errors.

This makes local and remote behavior honest:

- in the primary environment, a path identifies a desktop file;
- in a remote environment, the same-looking path identifies a file on that
  remote host; and
- the client never reinterprets a remote path on the desktop.

Classification prefers content signatures for PDF and common images, then
uses decoded text plus the extension. UTF-8 and BOM-marked UTF-16 are supported.
Text and Markdown transport is range-bounded to 2 MiB and decoding preserves a
valid prefix if the range ends within a multibyte character.

## Presentation adapters

| Prepared kind  | In-app presentation                                            |
| -------------- | -------------------------------------------------------------- |
| workspace file | Existing T3 Files panel and editor behavior                    |
| image or SVG   | Existing zoomable `PreviewImageSurface`                        |
| PDF            | Scient PDF reader through `PdfSourceDescriptor`                |
| Markdown       | Existing `ChatMarkdown` pipeline and rich fences               |
| text/source    | Existing read-only Pierre virtualized source renderer          |
| HTML           | Existing integrated Browser with read-only source fallback     |
| audio/video    | Native Chromium controls and range transport                   |
| unknown binary | File name, MIME type, size, refresh, and desktop editor action |

The thread-scoped surface persists only the requested absolute path and an
optional line; the thread supplies environment authority. It never persists an
expiring URL. Refresh reruns inspection and renews transport. Direct PDFs use
environment plus normalized canonical path as logical identity, so URL renewal
and thread changes preserve reader state while identical paths in different
environments remain isolated.

## File transport and HTML documents

`AssetResource.environment-file` has two explicit modes:

- `exact` issues a signed, one-file, revision-pinned capability. The route
  supports HEAD and byte ranges. If size or modification time changes, the
  stale URL returns 409 and the client renews it once.
- `html-document` issues a signed capability rooted at the canonical directory
  containing the entry document. Chromium can therefore request normal
  relative scripts, styles, fonts, data, images, media, and nested pages. These
  responses use `no-store`, so Browser reload reflects local edits immediately.
  The document capability lasts 24 hours because silently renewing its URL
  would reload the tab and discard interactive state; reopening the file issues
  a fresh capability. Exact file capabilities keep the one-hour renewable TTL.

The HTML mode deliberately preserves JavaScript and normal Browser networking;
it is not the old inert-document renderer. Each request is canonicalized again,
must resolve to a regular file inside the document directory, and cannot use
parent traversal, absolute paths, hidden sibling paths, or symlink escapes. The
entry document itself may be hidden. Malformed HTML and missing resources use
Chromium's normal recovery and network/error behavior rather than producing a
synthetic black viewer state.

Root-relative web-server URLs such as `/assets/app.js` are not reinterpreted as
local filesystem paths. Such bundles need their intended local dev/static
server. Rewriting arbitrary HTML, CSS, and runtime-generated URLs would be
incomplete and would create a second browser implementation.

## Ownership and upstream maintenance

Scient owns the contracts, preparation service, asset capability, presentation
adapters, right-panel descriptor, breadcrumb navigator, and shared file-path
clipboard behavior. Universal file opening and file-path affordances touch five
inherited T3 files:

1. `ChatMarkdown.tsx`: primary-click routing for workspace versus direct files,
   the HTML Browser action, and delegation to the shared path-copy handler.
2. `ChatView.tsx`: one lazy mount for the Scient file surface and the active
   workspace root supplied to right-panel full-path copying.
3. `rightPanelStore.ts`: the existing `openScient` branch refreshes a matching
   Scient descriptor in place, so reopening one file at a new line updates the
   reveal target without creating another tab.
4. `FilePreviewPanel.tsx`: one mount replaces the inherited display-only
   breadcrumbs while preserving the current-file scroll marker and the existing
   editor/save lifecycle.
5. `RightPanelTabs.tsx`: the existing file-tab context menu offers relative and
   full path copying through the shared handler.

The inherited editor/save lifecycle, Browser manager, and attachment/image paths
are unchanged. Static seam tests guard the file-opening boundary, while focused
component tests pin the additive breadcrumb and clipboard behavior. If T3 later
provides an extensible file-presentation registry, Scient should adapt these
owned presenters to it and retire the host seams.

The breadcrumb picker is shared by browser and desktop file previews and uses
the existing ignore-aware `projects.listEntries` cache. File-tab copy actions use
the native desktop context menu or the browser fallback. Mobile retains its
existing single `Copy path` action, and the file explorer tree remains unchanged;
those surfaces require separate product decisions rather than implicit parity.

New rich formats should extend preparation metadata and add a presenter without
adding producer-specific branches to the reader. Office/manuscript documents,
notebooks, TIFF/HEIC, scientific datasets, and future Artifact Studio
representations can therefore arrive incrementally. Producers should continue
to own durable identity and provenance; this opener owns only inspection,
authorization, routing, and viewing.

## Verification contract

Backend coverage must pin classification, bounded inspection, symlink
canonicalization, typed path failures, exact range transport, revision renewal,
HTML script/data MIME handling, traversal and hidden-path rejection, symlink
escape rejection, token tampering, and authorization scope. Web coverage must
pin persisted surface normalization, PDF identity across threads and
environments, repeated line-target replacement, incomplete multibyte decoding,
explicit HTML capability use, and the five narrow inherited host files above.
Typechecks and production builds verify the RPC and lazy-chunk boundaries.

Manual acceptance should cover light and dark themes, empty and large text,
line links, corrupt images/media, PDF state restoration, interactive HTML with
local assets, missing HTML assets, malformed HTML, an unsupported binary, and
the same cases through a remote environment.
