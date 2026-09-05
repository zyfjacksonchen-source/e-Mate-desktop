export default {
  entry: {
    index: 'src/index.ts',
    'collected-output': 'src/collected-output.ts',
    'oauth-callback': 'src/oauth-callback.ts',
    'plugin-source': 'src/plugin-source.ts',
    status: 'src/status.ts',
    'feishu-status': 'src/feishu-status.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: true,
  dts: true,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    alwaysBundle: [/^@modelcontextprotocol\/sdk(?:\/|$)/],
    onlyBundle: false,
  },
}
