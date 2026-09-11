import { createRequire } from 'node:module'
import { join } from 'node:path'

const root = import.meta.dirname
// 0.1.5's host apiproxy no longer depends on zod, so resolve the copy this
// package itself declares and bundles.
const zod = createRequire(join(root, 'package.json')).resolve('zod')

export default {
  entry: { index: join(root, 'lib/index.js') },
  outDir: join(root, '.runtime-bundle'),
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  alias: { zod },
  deps: {
    neverBundle: [/^@deepseek-ai\//],
    alwaysBundle: ['zod'],
    onlyBundle: false,
  },
}
