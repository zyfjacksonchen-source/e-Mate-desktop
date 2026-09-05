# Third-party components

Canvas integration is MIT licensed. The editor uses `@excalidraw/excalidraw` exactly `0.18.1`, MIT, from https://github.com/excalidraw/excalidraw/tree/v0.18.1. Its npm integrity is fixed by the main-agent-generated package lock. Cowart is an interaction reference only; no Cowart/tldraw/MCP/analytics/cloud runtime is included.

`fflate@0.8.3` (MIT) handles portable project archives. Native React/ReactDOM and Harness services are external references to the pinned application's module table, not additional bundled runtime instances.

The module build copies the exact Excalidraw font bytes and stylesheet into `lib/assets`. Font license texts and source metadata are in `licenses/` and copied into `lib/licenses/`. Excalifont and Comic Shanns metadata are extracted from the pinned Excalidraw source. Assistant, Cascadia, Liberation, Lilita One, Nunito, Virgil and Xiaolai license texts come from their upstream repositories. Font bytes are neither renamed nor modified. The font families retain their respective OFL/MIT terms, including reserved font names.

Sources for the retained font licenses:

- https://github.com/excalidraw/virgil/blob/main/LICENSE.md
- https://github.com/microsoft/cascadia-code/blob/main/LICENSE
- https://github.com/liberationfonts/liberation-fonts/blob/main/LICENSE
- https://github.com/google/fonts/blob/main/ofl/assistant/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/lilitaone/OFL.txt
- https://github.com/google/fonts/blob/main/ofl/nunito/OFL.txt
- https://github.com/lxgw/kose-font/blob/master/OFL.txt

The only dependency-source adaptation is a build-time substitution of Excalidraw's font fallback URL with the same-origin package asset path. CJS browser dependency resolution is explicit because tsdown 0.22 otherwise selects Node variants; no Node polyfill is added. `import.meta.url` is unavailable inside the native closure factory, so Excalidraw's existing main-thread font-subsetting fallback remains its owner.

The build also writes `lib/THIRD_PARTY_NOTICES.txt` from the package metadata and available license files of the actual bundled modules, and `lib/assets/asset-manifest.json` records asset sizes and SHA-256 hashes. These generated receipts are not committed as source.
