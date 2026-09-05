# Development log

## 2026-09-02: native lifecycle consolidation

- The current source target is `2.0.17` and remains pinned to DSH `0.1.0-rc.7@4da69d7c3522ee51de12822c917c503a124f7a7d` and Desktop reference `6074088f5b660206e404b3591fab51fb99c69add`; this makes no candidate, installed, or public-production claim.
- `desktop/e-mate-desktop` is the sole Electron build, package, install, replacement, and update owner. The earlier local-flow, schema-2 publication, Profile hot-update, custom installer, and custom rollback implementations are retired.
- Natural-language update remains a trigger into the same Desktop interactive update lifecycle; it does not contain download or install logic.
- macOS remains an unsigned local build. Windows remains an unsigned native build on the signed-in Codex Remote Windows host. GitHub Actions validates source but does not produce release installers.
- Historical release-train contracts, evidence snapshots, acceptance images, and obsolete packaging scripts were removed from the active source tree. Exact source, candidate, installed, and public evidence remain separate.

## 2026-09-05: 2.0.18 approved implementation begins

- Independent source baseline `87b47114ff30882d2895682e74d02eb6307b9dbc`; execution and acceptance are recorded in `docs/2.0.18/execution.md` and `work-orders.json`.
- Main agent owns integration and all native/production gates; enterprise, Computer Use and image development have isolated first-wave worktrees.
- Source capabilities and older local receipts are not new installed or production acceptance. All final gates remain OPEN.
