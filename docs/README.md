# Scient desktop candidate docs

The current application surfaces use the Scient product identity. Most user
and internal documents below remain inherited T3 host documentation until each
owner is reconciled through the migration; they must not be mistaken for
Scient release authority.

## Using T3 Code

- [Install and first run](./user/install.md)
- [Permission modes](./user/permission-modes.md)
- [Keyboard shortcuts](./user/keybindings.md)
- [Organizing threads](./user/thread-sidebar.md)
- [Forking conversations](./user/conversation-forks.md)
- [Review usage](./user/usage.md)
- [Customize a project icon](./user/project-settings.md)
- [Mobile appearance](./user/mobile-appearance.md)
- [Remote access](./user/remote-access.md)
- [Keeping app and server in sync](./user/updating.md)
- [Source control integrations](./user/source-control.md)
- [Starting a project](./user/projects.md)
- [File previews](./user/file-previews.md)
- [Reading PDFs](./user/pdf-reader.md)
- [Diagrams in chat](./user/diagrams-in-chat.md)
- [Images in chat](./user/images-in-chat.md)
- [Interactive charts in chat](./user/charts-in-chat.md)
- [Scientific computing](./user/scientific-computing.md)
- [Run a MATLAB file](./user/matlab-run-file.md)
- [Sources and Zotero import](./user/sources.md)
- [Background service (Linux)](./user/background-service.md)
- Providers: [Codex](./user/providers-codex.md) · [Claude](./user/providers-claude.md)

Mobile app: [apps/mobile/README.md](../apps/mobile/README.md)

---

## Working on T3 Code

Everything below is for maintainers. Setup lives in the [root README](../README.md);
policy in [CONTRIBUTING.md](../CONTRIBUTING.md); agent rules in [AGENTS.md](../AGENTS.md).

- [Architecture overview](./internals/overview.md)
- [Workspace layout](./internals/workspace-layout.md)
- [Glossary](./internals/glossary.md)
- [Scripts](./internals/scripts.md)
- [Connection runtime](./internals/connection-runtime.md)
- [Providers](./internals/providers.md)
- [Remote environments](./internals/remote.md)
- [Server updates](./internals/server-updates.md)
- [Resource telemetry](./internals/resource-telemetry.md)
- [Scient conversation-fork architecture](./internals/scient-fork-divergence.md)
- [Environment auth](./internals/environment-auth.md)
- [T3 Connect](./internals/t3-connect.md)
- [Scient project initialization](./internals/scient-project-initialization.md)
- [Scient Sources foundation](./internals/scient-sources.md)
- [Scient PDF export and rendering implementation plan](./internals/scient-pdf-export-rendering-plan.md)
- [Scient analysis runtime foundation](./internals/scient-analysis-runtime-foundation.md)
- [Scientific Artifact Studio roadmap](./internals/scientific-artifact-studio.md)
- [Scient rich chat diagrams](./internals/scient-chat-diagrams.md)
- [Scient inline workspace images](./internals/scient-chat-images.md)
- [Scient rich chat visualizations](./internals/scient-chat-visualizations.md)
- [D4 bootstrap record](./internals/scient-next-d4-bootstrap.md)
- [T3 foundation refresh (2026-08-07)](./internals/t3-foundation-refresh-20260807.md)
- [Candidate upstream maintenance](../UPSTREAM.md)
- [CI gates](./internals/ci.md)
- [Engineering work artifacts](./internals/work-artifacts.md)

### Runbooks

- [Scient local dev app](./operations/local-dev-app.md)
- [Release](./operations/release.md)
- [Observability](./operations/observability.md)
- [Relay observability](./operations/relay-observability.md)
- [Mobile app store screenshots](./operations/mobile-app-store-screenshots.md)
