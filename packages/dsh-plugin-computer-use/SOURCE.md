# Source receipt

## Existing Darwin owner

- Repository: `https://github.com/Anionex/dsh-computer-use`
- Commit: `76bfe8607f61945c1cbb84e73976e601100c13a2`
- Version: `0.1.0`
- License: MIT (notice retained in `LICENSE`)
- Current native helper source and binary hashes are recorded in `native/macos/manifest.json` at build time.

The e-Mate adapter changes package/client identity, explicit-turn activation, capability projection and platform delivery. The Darwin provider, service, Tools, Skill, Settings, approvals and artifacts remain based on this exact source. The narrow macOS helper adaptation requires the observed window ID, PID and geometry throughout screenshot capture, removing title/largest-window substitution. The Profile sets cursorMotionMs to zero to remove the native provider's fixed 180 ms presentation wait without changing observation or input calibration. The existing native builder rebuilds the locally maintained helper when its source hash changes.

## Windows primitive provenance

- Repository: `https://github.com/jing-hy/computer-user`
- Commit: `2fbf383b49fe08e466d4d1caba659fb42b61de6b`
- License: MIT (notice retained in `LICENSE`)
- Audited candidate files/blobs:
  - `LICENSE` — `86e71c1095046ee74104b31fa4cd74b291fa03cf`
  - `src/capture.ps1` — `c26f3aec9e5ae7056567b8a9668676f5b721a7d4`
  - `src/input.ps1` — `c3b980cd0295f2e01b83ac7bd444404e7f80e1c3`
  - `src/ps.js` — `4f0ff5cbd663fd68737a3afdc0f5238540022ac9`
  - `tests/computer-user.test.js` — `0fec82640327f556d119d9777e18ae1a640fa3b9`
  - `tests/output-guard.test.js` — `5484ed08bb170dfe510a0abd2e9d03f06c6e3382`

Incorporated adaptations in `native/windows/dsh-computer-use-helper.ps1` are limited to: the DPI-awareness concept from `capture.ps1` lines 15–19 and the bounded key-name mapping idea from `input.ps1` lines 58–83. The implementation now requires per-monitor-v2 DPI and captures the exact HWND with PrintWindow; it does not retain CopyFromScreen. No candidate JavaScript, plugin registration, config/settings, client, Skill, Tool registry, process-global approval Set, `computer_set_mode`, raw `spawn`, arbitrary output path, or LLM output guard is incorporated. `src/ps.js` and both candidate test files were audited but contributed no runtime code.

The maintained Windows host code is TypeScript. The single packaged PowerShell helper is invoked through `ctx.subprocess` using serial bounded JSONL stdin/stdout, a per-generation integrity check and version handshake, exact request/response identity, and deterministic process-tree disposal. The helper reuses loaded UIA/Win32 assemblies and never owns a server or global transport. Native executable path, process-start, and HWND facts stay in a backend `WeakMap`; public application identities expose only an opaque normalized-path hash, PID, and name. Windows installed-machine evidence remains OPEN until a later authorized native build and real-machine test.

Windows API references: [UI Automation control patterns](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview), [PrintWindow](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-printwindow), [WM_MOUSEWHEEL coordinates](https://learn.microsoft.com/en-us/windows/win32/inputdev/wm-mousewheel). Wheel fallback uses documented native control scrolling messages instead of incorrectly encoding client coordinates as a screen-space wheel message.

UIA observation batches use [observation-scoped CacheRequest](https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/caching-in-ui-automation-clients) with explicit TreeWalker cache arguments. Every observe and pre-action observation creates a new cache; act resolves the current target again.
