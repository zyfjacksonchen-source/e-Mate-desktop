/** Native files that every universal macOS package must carry. */

export type MacUniversalArch = 'arm64' | 'x86_64'

export const MACOS_UNIVERSAL_NATIVE_ENTRIES = [
  { arch: 'arm64', path: 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-0.35.3.node' },
  { arch: 'arm64', path: 'node_modules/@img/sharp-libvips-darwin-arm64/lib/libvips-cpp.8.18.3.dylib' },
  { arch: 'arm64', path: 'node_modules/@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node' },
  { arch: 'arm64', path: 'node_modules/@vscode/ripgrep-darwin-arm64/bin/rg' },
  { arch: 'arm64', path: 'node_modules/node-addon-require-builtin-darwin-arm64/prebuilt/darwin-arm64-napi-v9.node' },
  { arch: 'arm64', path: 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node' },
  { arch: 'arm64', path: 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper' },
  { arch: 'x86_64', path: 'node_modules/@img/sharp-darwin-x64/lib/sharp-darwin-x64-0.35.3.node' },
  { arch: 'x86_64', path: 'node_modules/@img/sharp-libvips-darwin-x64/lib/libvips-cpp.8.18.3.dylib' },
  { arch: 'x86_64', path: 'node_modules/@koromix/koffi-darwin-x64/darwin_x64/koffi.node' },
  { arch: 'x86_64', path: 'node_modules/@vscode/ripgrep-darwin-x64/bin/rg' },
  { arch: 'x86_64', path: 'node_modules/node-addon-require-builtin-darwin-x64/prebuilt/darwin-x64-napi-v9.node' },
  { arch: 'x86_64', path: 'node_modules/node-pty/prebuilds/darwin-x64/pty.node' },
  { arch: 'x86_64', path: 'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper' },
] as const satisfies readonly { readonly arch: MacUniversalArch; readonly path: string }[]

export const FORBIDDEN_MACOS_UNIVERSAL_ENTRIES = [
  'node_modules/node-pty/build/Release/pty.node',
  'node_modules/node-pty/build/Release/spawn-helper',
] as const
