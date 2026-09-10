export default {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
}
