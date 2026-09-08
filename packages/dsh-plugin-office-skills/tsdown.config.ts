import { clientBundle } from '../../upstream/deepseek-harness/packages/client/tsdown.client.ts'
const officeDependencies = [
  '@pdf-lib/fontkit',
  '@xmldom/xmldom',
  'docx',
  'jszip',
  'pdf-lib',
  'pptxgenjs',
]

const host = {
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  deps: {
    neverBundle: [/^@deepseek-ai\//, '@e-mate/desktop/vision-toolkit'],
    alwaysBundle: officeDependencies,
  },
}

export default clientBundle('@e-mate/dsh-plugin-office-skills', ['src/index.ts', 'src/preview.ts'], { lib: { ...host, clean: false } })
