# Managed Calc preparation

`prepare-calc-runtime.mjs` prepares the fixed macOS 26.8.0 assets within the Desktop workspace. It verifies archive bytes, retains each complete app and its notices, and checks all files, modes and symlinks when reusing the prepared cache. It also copies the existing, pinned Noto Sans SC asset and its provenance/license documents.

Run from `desktop`:

```sh
node e-mate-desktop/scripts/prepare-calc-runtime.mjs --archive-dir /absolute/archive/cache
node --test e-mate-desktop/scripts/prepare-calc-runtime.spec.mjs
```

The existing Desktop build calls this preparation step; its afterPack hook uses `--verify-root` to inspect the finished resources without downloading or changing them. Both architectures are required for a universal Mac app. This is not a separate installer or publication entry point. Native Windows extraction, source-companion delivery and real installed acceptance remain required before release. Unknown targets fail explicitly. Prepared bytes are generated output and remain outside source control.
