export default {
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  outDir: 'lib',
  deps: { neverBundle: ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis'] },
}
