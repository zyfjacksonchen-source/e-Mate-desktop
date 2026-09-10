# Upstream source

Vendored from dream-num/dsh-univer-office 0.2.14 at commit `f3a8845dd4c863072b0ae555cdb6a58076c165e7` under Apache-2.0. `upstream-manifest.json` records the original tracked bytes. Generated artifacts are built from the local source for each target platform.

The e-Mate component uses the existing Profile bundle mechanism and frozen DSH 0.1.0-rc.7 services. The adaptations below retain the pinned upstream application owners. No separate Office Tool implementation is retained.

## Local adaptations

- Package identity becomes `@e-mate/dsh-plugin-univer-office@2.0.18`; exact original source hashes remain in `upstream-manifest.json`. The original Apache-2.0 license and all upstream files are retained except the version-probing Client compatibility module, replaced by the single fixed rc.7 path.
- Manifest peers and Base imports use the existing rc.7 packages. Host uses the branded settings namespace and native `CallId`. Client uses the native combined conversation/runtime APIs, hidden per-root Chat projections and actual Code subcall identities, with session/workspace-bound polling and teardown.
- The existing dependency copier now materializes all six locked runtime dependencies, recursively preserving nested versions, optional native targets and licenses. The bundled Host resolves its own `node_modules` beside `lib`. Desktop permits only declared local dependencies whose real paths stay inside the component; Base services remain exclusive to the fixed runtime.
- Product telemetry defaults to false; automatic lifecycle hooks are not registered. Explicit upstream opt-in/out behavior remains covered by its original telemetry test assertions.
- Original Gateway, Worker, Viewer, Render Machine and eight Skill implementations remain unchanged. Host/Client tests adapt native rc.7 types and add actual projection/lifecycle coverage; original integration and skills smoke scripts remain byte-identical. Both READMEs document the actual deployment and platform limits.

## Verified scope and open limits

All five build targets, Host/Client checks, telemetry and eight Skills passed locally. The original integration suite ran actual Gateway, Worker and browser operations for five Unit types, imports/exports, screenshots/PDF, history and draft lifecycle on macOS ARM64. An independently materialized package also loaded through the real Desktop Profile resolver and started its Gateway. These are source/local checks, not installed or public release acceptance.

The pinned formula and conversion dependencies do not publish or resolve `darwin-x64`. The Desktop preflight and final physical-package checks reject universal/Intel builds; no substitute binary, relaxed gate, different Harness version or runtime installation is used. Windows native execution and dual-platform installed acceptance remain separate gates.
