import { fileURLToPath } from 'node:url'
import tsconfigPaths from '../../upstream/deepseek-harness/node_modules/vite-tsconfig-paths/dist/index.js'
import { standardDecoratorPlugin } from '../../upstream/deepseek-harness/vitest.shared.ts'
import { emateClientTestAliases } from '../../scripts/emate-client-test-aliases.mjs'

export default {
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: emateClientTestAliases,
  },
  plugins: [
    tsconfigPaths({
      projects: [fileURLToPath(new URL('../../upstream/deepseek-harness/tsconfig.base.json', import.meta.url))],
    }),
    standardDecoratorPlugin(),
  ],
  test: {
    environment: 'jsdom',
    include: ['test/*.spec.tsx'],
  },
}
