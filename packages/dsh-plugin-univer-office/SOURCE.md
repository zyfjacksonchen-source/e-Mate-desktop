# Upstream source

Vendored from dream-num/dsh-univer-office 0.2.14 at commit `f3a8845dd4c863072b0ae555cdb6a58076c165e7` under Apache-2.0. `upstream-manifest.json` records the original tracked bytes. Application artifacts are built from the local source; native dependencies are installed separately on the user host.

This is an on-demand npm plugin for frozen DSH 0.1.0-rc.7 services, installed through e-Mate's native plugin workflow. It is not included in the e-Mate application bundle. The adaptations below retain the pinned upstream application owners. No separate Office Tool implementation is retained.

## Local adaptations

- Package identity is `@e-mate/dsh-plugin-univer-office@2.0.18`; exact original source hashes remain in `upstream-manifest.json`. The upstream Apache-2.0 license and existing notices are retained. The version-probing Client compatibility module is replaced by the single fixed rc.7 path.
- Manifest peers and Base imports use the existing rc.7 packages. Host uses the branded settings namespace and native `CallId`. Client uses the native combined conversation/runtime APIs, hidden per-root Chat projections and actual Code subcall identities, with session/workspace-bound polling and teardown.
- The TGZ uses the manifest's `files` allowlist and normal `pnpm pack`. The app-only dependency copier and `bundledDependencies` are removed. All six exact runtime dependencies remain in `dependencies`; the user's native package manager resolves their platform packages during installation. The TGZ contains no copied `node_modules`, native libraries, or second DSH runtime.
- Product telemetry defaults to false; automatic lifecycle hooks are not registered. Explicit upstream opt-in/out behavior remains covered by its original telemetry test assertions.
- Original Gateway, Worker, Viewer, Render Machine and eight Skill implementations remain unchanged. Host/Client tests adapt native rc.7 types and add actual projection/lifecycle coverage; original integration and skills smoke scripts remain byte-identical. Both READMEs document the actual deployment and platform limits.

## Verified scope and open limits

The complete package test command builds Host/Client, Gateway, Worker, Viewer and Render Machine, then checks Host, integration, Client, comparison, eight Skills and telemetry. Archive checks cover the actual TGZ manifest, required application entries and absence of `node_modules`. These are source/local checks; installation from the TGZ, npm/catalog publication and user acceptance are separate evidence gates.

The pinned formula and conversion dependencies do not publish or resolve `darwin-x64`. Moving installation to the user's host does not create a missing native target. Windows native execution and installed plugin acceptance remain separate gates. Native dependency availability no longer determines whether the e-Mate app can be packaged, because this plugin is distributed separately.

## Authorization scope

On 2026-09-10, the user explicitly confirmed: “已获授权，我是 Univer Pro 的协作者”. This records the user's authorization statement, not a contract document or an interpretation of its terms. The plugin's Apache-2.0 license does not relicense Univer Pro dependencies; their own authorization, license and notice terms remain applicable.
