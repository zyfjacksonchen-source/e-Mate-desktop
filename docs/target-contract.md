# e-Mate Desktop 2.0.18 target contract

This is the active repository contract. It supersedes historical release-train notes, evidence matrices, and retired publication flows.

## Identity and pins

- Product name: `e-Mate`
- Product version: `2.0.18`
- GitHub repository: `zyfjacksonchen-source/e-Mate-desktop`
- DSH package baseline: `@deepseek-ai/dsh@0.1.0-rc.7`
- Harness: `zyfjacksonchen-source/deepseek-harness@4da69d7c3522ee51de12822c917c503a124f7a7d`
- Desktop reference: `anywhere-labs/deepseek-harness-desktop@6074088f5b660206e404b3591fab51fb99c69add`

### Source capability and compatibility

The 2.0.18 source capability/compatibility surface includes native `image_batch`, zero image/edit confirmation, universal ordinary-file upload, the pinned Windows source backend, enterprise authentication recovery, and bounded direct-image latency. This states source capability only and makes no candidate, installed, or public-production claim.

All maintained application source is TypeScript/TSX. Generated JavaScript and packaged assets are build output, not a second implementation.

## Governance

The main agent is the sole supervisory manager. It assigns the worktree, baseline, mutually exclusive write sets, and work orders; reviews and integrates changes; enforces evidence gates; and owns installed acceptance, release, and rollback decisions.

Subagents may change only their assigned write set and run the narrowest relevant test. They do not independently expand scope, change versions, build or package installers, install, deploy, push, clean, integrate, or decide release-contract outcomes.

## Ownership

Pinned DSH rc.7 owns the Agent Loop, Sessions, durable events, model calls, Tools, approvals, attachments, Jobs, schedules, Skills, plugin loading, workspace state, and persistence. e-Mate extends those owners through existing Cordis/Profile seams and does not clone them.

Pinned DSH and `deepseek-harness-desktop` are the only native standards. There is no parallel UI, store, router, transport, Host, Agent Loop, updater, package manager, or fallback. Delete divergent paths and return callers to their native owner.

Pinned `deepseek-harness-desktop` owns the Electron lifecycle. `desktop/e-mate-desktop` is e-Mate's sole build, package, install, replacement, relaunch, and update implementation. There is no root release coordinator, alternate installer, Profile hot updater, schema-2 publication system, custom health rollback, or fallback desktop shell.

## Product adaptations

Allowed e-Mate adaptations are branding, the product Profile, enterprise identity and model policy, asynchronous redacted audit, native platform adapters required by packaged Electron, and unsigned-distribution presentation. A change outside those bounds must first prove that the pinned native owner cannot represent the requirement.

Natural-language update requests only trigger `desktopUpdates.runInteractiveUpdate()`. Background, tray, Settings, and Agent requests share the same Desktop lifecycle and the same version/download endpoints.

## Build and delivery

- Development uses Node 24.x, root `pnpm@11.7.0`, and the Desktop Yarn lock.
- Main-agent-authorized macOS packaging runs with process workdir `desktop` and uses `corepack yarn dist:mac` locally on macOS.
- Main-agent-authorized Windows packaging runs with process workdir `desktop` and uses `corepack yarn dist:win` on the already signed-in Codex Remote Windows host. SSH is not a packaging, GUI acceptance, or installed-evidence path.
- GitHub `e-Mate-desktop` stores source identity, review, and source CI. GitHub Actions, artifacts, tags, and releases are not installer production, installed acceptance, or the public release transport.
- Cloudflare/R2 is the public-production delivery boundary. Immutable objects must be uploaded and read back before official version and platform pointers are activated.
- macOS and Windows installers are intentionally unsigned. Documentation and UI must state that truthfully and must not emulate signing or notarization.
- macOS installs and replaces the canonical `/Applications/e-Mate.app`. Windows uses the canonical assisted NSIS installation and shortcut locations. Neither platform leaves a second application copy after successful replacement.
- Online update accepts only a strictly newer stable SemVer. Same-version replacement uses the official manual download page.
- Exact installer bytes must pass install, in-place replacement, and launch checks on both platforms before publication.

## Private update acceptance and same-byte promotion

These are required release gates, not evidence that the candidate or promotion implementation has passed review or been deployed. All entry points below belong to `desktop/e-mate-desktop/scripts`; the main agent retains all existing review, installed-acceptance, release, and rollback authority.

1. **Candidate identity:** build real 2.0.18 binaries from one final source on native macOS and Codex Remote Windows. Retain the 2.0.17 fixes; never rename a 2.0.17 installer or change only its manifest to 2.0.18. Store the manifest and both installers privately under `desktop/candidates/<source_commit>/`, with full-byte readback and SHA-256 evidence.
   Starting with 2.0.18, the manifest and both platform receipts use schema 2 and bind the same `source_companion: { key, bytes, sha256 }`. Its fixed private key is `desktop/candidates/<source_commit>/sources/e-Mate-<version>-calc-sources.tar`; the enclosing source identity and fixed path bind it to the candidate. The archive contains the corresponding-source index and materials for the bundled Calc distribution. Historical schema 1 before 2.0.18 remains readable; omitting the companion or downgrading the schema cannot admit a current release. This manifest schema is unrelated to the removed signing orchestration.
2. **Private discovery:** `candidate-update-worker.mjs` is the source-locked, expiring-token, read-only HTTPS reader for only `/desktop/version.json`, `/desktop/downloads/mac`, and `/desktop/downloads/windows`. `launch-update-canary.mjs` redirects only those three native update URLs; TLS verification remains enabled, original executable/archive/framework bytes remain unchanged, and the inspector must close. Tokens must not appear in logs or command-line arguments. Route readiness or an update prompt is not native-install acceptance.
3. **Installed acceptance:** test the real 2.0.16-to-2.0.18 native download, in-place install, and normal launch on each platform, preserving the same installation path, `DSH_HOME`, userData, installation-id hash, and real test session throughout. Record actual download bytes/SHA-256, launched version, and closed debug port. Store both real receipts under the same private source. A broken, unlaunchable 2.0.17 installation also requires official 2.0.18 same-path manual replacement recovery; it cannot self-heal through a same-version 2.0.17 feed.
4. **Single validation boundary:** `verify-update-acceptance.mjs <candidate-manifest.json> <mac-acceptance.json> <windows-acceptance.json>` invokes `update-acceptance-validation.mjs`. The promotion Worker must use that same validator on the private, fixed-source manifest and receipts before any public write. Missing/false/mismatched evidence must produce zero public writes; fixture success does not establish real acceptance.
5. **Only promotion entry:** `candidate-promotion-worker.mjs` must require an explicitly expiring token and conditionally reserve a persistent private-R2 historical-highest-version record binding source and both installer hashes before the first public write. The main agent initializes historical 2.0.17 from real publication evidence; missing history fails closed. Reject downgrades, same-version different source/bytes, and concurrent candidate substitution; interrupted identical candidates may resume. Promote only the accepted bytes, read back immutable objects and aliases, and write the public version pointer last. Partial failures must report sanitized phase/operations, not falsely imply zero writes.
   Promotion checks the stored SHA-256 checksum, size and source/version metadata of all three private artifacts before claiming the release. The companion hash and size are part of the persistent candidate identity. After preflighting every immutable target, promotion writes and reads back the source archive before the installers, then activates the existing aliases and version pointer. Historical objects missing a stored checksum fail closed and require verified original-byte ingestion through the existing private candidate path. The completion receipt includes the companion's immutable key, size, hash and readback. Public archive access and its corresponding-source completeness still require separate real acceptance.
6. **Completion:** after public activation, the Worker must persist its completion receipt under the same private source. The official website must consume that receipt, not a handwritten success status. Read back official version, platform pointers, and website against the accepted source/bytes, then remove temporary services and short-lived credentials under main-agent control. No separate copy/version publication route may bypass promotion.

## Compatibility boundaries

- DSH `0.1.0-rc.7` is fixed. rc.8 packages, peers, fixtures, or inferred behavior are rejected.
- Existing user data is read and mutated only through native DSH owners. Legacy imports remain read-only at their source.
- Enterprise services may authenticate, apply bounded model/search policy, lease credentials, and append redacted audit. They never execute local Tools, mutate Sessions, install Skills, or control the Desktop updater.
- Browser plugins use Harness Connection, services, events, and slots. They do not open a parallel WebSocket/SSE transport or manufacture Session, Tool, approval, retry, or completion state.

## Evidence gates

1. **Source:** the reviewed source diff and its named focused checks. It proves no installer bytes.
2. **Candidate:** exact source provenance, fixed pins, installer bytes, and hashes from authorized native builds for each platform. It proves no installation.
3. **Installed:** those exact bytes install, replace in place, and launch on local macOS and the logged-in Codex Remote Windows machine. It proves no public activation.
4. **Public production:** immutable Cloudflare/R2 objects plus the official version and platform pointers are activated and read back. GitHub state is not a substitute.

Every gate fails closed at the first missing or mismatched fact. Tests and fixtures prove only their named boundary; another candidate, historical receipts, waivers, or narrative approval cannot fill a gap. This contract defines the `2.0.18` source target and makes no claim that installed acceptance, release, or rollback has occurred.
