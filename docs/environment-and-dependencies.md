# Environment and dependencies

## User environment

- macOS 13+ on Apple Silicon or Intel, delivered as one Universal DMG.
- Windows 10/11 x64, delivered as one assisted NSIS installer.
- Linux is not a 2.0.17 release target.
- Installers contain their runtime closure. Users do not install Node, npm, pnpm, Yarn, Python, Electron, Xcode, MSVC, or Rust.
- Both installers are unsigned. The official download page publishes immutable URLs and SHA-256 values plus the macOS trust instructions.

## Development environment

- Node 24.x.
- Corepack with exact root `pnpm@11.8.0`.
- Desktop Yarn project and immutable lock under `desktop/`.
- Harness `0.1.5-rc.1@d1d095bee770c3e9d302f844083e02f0b74576ee`.
- Desktop reference `anywhere-labs/deepseek-harness-desktop@166c16cfc38c51d32c2316715548c0f8271db517`.

Install and test the source with the existing pinned package managers. Build installers only through the Desktop workspace:

```bash
cd desktop
corepack yarn install --immutable
corepack yarn check
corepack yarn dist:mac
corepack yarn dist:win
```

Run the macOS command on macOS and the Windows command on the signed-in Codex Remote Windows host. CI may run checks but does not replace either native build.
