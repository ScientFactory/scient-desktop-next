# Scient Desktop documentation

This is the documentation index for the active Scient Desktop application.
Some internal documents retain inherited T3 terminology where it describes the
host platform or historical ancestry; that terminology is not product identity
or release authority.

Related documentation also lives in the separate
[Scient repository](https://github.com/ScientFactory/Scient/blob/main/docs/README.md).
Topics may span repositories; follow the relevant documents and their ownership
or supersession links rather than assuming either repository contains all guidance.

The logical roles are Help, Capabilities, Architecture, Development,
Operations, Upstream, and Records. They map to the real compatibility paths
below: `docs/user/` is the authored Help source for public Scient Docs;
`docs/internals/` currently contains several maintainer roles;
`docs/operations/` contains runbooks; `UPSTREAM.md` owns T3 divergence and
routes to dated receipts; and package READMEs stay beside the package they
explain. Update the existing owner before creating a new file. The roles do not
require a cosmetic folder migration.

## Using Scient Desktop

- [Install and first run](./user/install.md)
- [Getting started](./user/getting-started.md)
- [Import projects and conversations](./user/welcome-wizard.md)
- [Starting a project](./user/projects.md)
- [Message Scient](./user/composer.md)
- [Providers and assisted setup](./user/providers.md)
  - [Codex](./user/providers-codex.md)
  - [Claude](./user/providers-claude.md)
  - [Antigravity](./user/providers-antigravity.md)
  - [Grok](./user/providers-grok.md)
  - [Droid](./user/providers-droid.md)
  - [Cursor](./user/providers-cursor.md)
  - [OpenCode](./user/providers-opencode.md)
  - [Pi](./user/providers-pi.md)
- [Permission modes](./user/permission-modes.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Project settings](./user/project-settings.md)
- [Voice dictation](./user/voice-dictation.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Environment themes](./user/environment-theme.md)
- [Appearance and themes](./user/appearance.md)
- [SnapShots](./user/snap-shot.md)
- [Import browser sessions](./user/browser-import.md)
- [Usage and limits](./user/usage.md)
- [Product usage data](./user/telemetry.md)
- [Review usage](./user/usage.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [File previews](./user/file-previews.md)
- [Reading PDFs](./user/pdf-reader.md)
- [Math in chat and Markdown](./user/math-in-chat.md)
- [LaTeX projects](./user/latex.md)
- [Content direction and RTL/LTR](./user/content-direction.md)
- [Diagrams in chat](./user/diagrams-in-chat.md)
- [Images in chat](./user/images-in-chat.md)
- [Interactive charts in chat](./user/charts-in-chat.md)
- [Scientific computing](./user/scientific-computing.md)
- [Run a MATLAB file](./user/matlab-run-file.md)
- [Sources and Zotero import](./user/sources.md)
- [Background service (Linux and macOS)](./user/background-service.md)

---

## Working on Scient Desktop

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Unread answers and Dock badge](./internals/answer-attention.md)
- [Workspace layout](../AGENTS.md#where-code-lives)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Voice input](./internals/voice-input.md)
- [Providers](./internals/providers.md)
- [Provider lifecycle architecture](./internals/provider-lifecycle.md)
- [Provider lifecycle capability audit](./internals/provider-lifecycle-capability-audit.md)
- [Codex runtime and authentication](./internals/scient-codex-runtime-auth.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Scient conversation-fork architecture](./internals/scient-fork-divergence.md)
- [Mobile navigation headers](./internals/mobile-navigation.md)
- [Scient product analytics](./internals/product-analytics.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Scient project initialization](./internals/scient-project-initialization.md)
- [Scient workspace file browsing and visibility](./internals/scient-workspace-file-visibility.md)
- [Scient onboarding](./internals/scient-onboarding.md)
- [Scient skills core](./internals/scient-skills.md)
- [Scient Sources foundation](./internals/scient-sources.md)
- [Scient thread queue and upstream retirement seam](./internals/scient-thread-queue.md)
- [Scient voice architecture](./internals/scient-voice.md)
- [Custom model connections](./internals/custom-models.md)
- [Scient mobile release hold](./internals/scient-mobile-release-hold.md)
- [Scient Browser PDF export](./internals/scient-browser-pdf-export.md)
- [Historical PDF export and rendering plan](./internals/scient-pdf-export-rendering-plan.md)
- [Scient analysis runtime foundation](./internals/scient-analysis-runtime-foundation.md)
- [Scient stateful compute foundation and capability roadmap](./internals/scient-compute-session-foundation.md)
  - [Planned runnable code blocks in chat and Markdown](./internals/scient-compute-session-foundation.md#follow-up-runnable-code-blocks-in-chat-and-markdown)
- [Scientific Compute Toolkits and runtime setup](./internals/scient-compute-toolkit-foundation.md)
- [Superseded repository copy of the Scientific Artifact Studio roadmap](./internals/scientific-artifact-studio.md)
- [Canonical cross-product Scientific Artifact Studio roadmap](https://github.com/ScientFactory/Scient/blob/main/docs/planning/scientific-artifact-studio.md)
- [Scient universal file opening](./internals/scient-universal-file-opening.md)
- [Scient PDF reader](./internals/scient-pdf-reader.md)
- [Scient LaTeX](./internals/scient-latex.md)
- [Scient content direction](./internals/scient-content-direction.md)
- [Scient typography profile](./internals/scient-typography.md)
- [Scient math rendering](./internals/scient-math.md)
- [Scient rich Markdown editor](./internals/scient-rich-markdown-editor.md)
- [Scient rich chat diagrams](./internals/scient-chat-diagrams.md)
- [Scient inline workspace images](./internals/scient-chat-images.md)
- [Scient rich chat visualizations](./internals/scient-chat-visualizations.md)
- [Scient release-note system](./internals/scient-release-notes.md)
- [D4 bootstrap record](./internals/scient-next-d4-bootstrap.md)
- [T3 foundation refresh (2026-08-07)](./internals/t3-foundation-refresh-20260807.md)
- [Upstream maintenance and dated integration-record collection](../UPSTREAM.md)
- [T3 upstream alignment protocol](./internals/upstream-alignment-protocol.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)

### Dated forensic records

These reports preserve investigation evidence and evolution history. They are
not substitutes for current implementation, `UPSTREAM.md`, or maintained help
and capability owners.

- [Scient-specific capability catalog](./reports/scient-specific-capabilities.md)
- [Scient PR and evolution ledger](./reports/scient-pr-and-evolution-ledger.md)
- [Scient/T3 divergence, integration, provenance, and retirements](./reports/scient-t3-divergence-integration-and-retirements.md)

### Historical delivery and migration records

These records preserve completed plans, review wording, or migration evidence.
Follow their linked successors for current behavior.

- [Provider lifecycle unification delivery proposal](./internals/provider-lifecycle-unification-proposal.md)
- [Conversation-fork modernization PR drafts](./internals/scient-fork-pr-descriptions.md)
- [v0.6.0 migration rehearsal](./operations/v060-migration-rehearsal.md)

### Runbooks

- [Scient local dev app](./operations/local-dev-app.md)
- [Release](./operations/release.md)
- [Managed provider runtime updates](./operations/managed-provider-runtime-updates.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
- [Inherited mobile source](../apps/mobile/README.md)
