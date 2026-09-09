import { fileURLToPath } from 'node:url'
import tsconfigPaths from '../../upstream/deepseek-harness/node_modules/vite-tsconfig-paths/dist/index.js'
import { standardDecoratorPlugin } from '../../upstream/deepseek-harness/vitest.shared.ts'

const upstreamModules = fileURLToPath(new URL('../../upstream/deepseek-harness/node_modules/', import.meta.url))

export default {
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      'react-dom': `${upstreamModules}.pnpm/node_modules/react-dom`,
      react: `${upstreamModules}.pnpm/node_modules/react`,
      '@testing-library/react': `${upstreamModules}@testing-library/react`,
      '@deepseek-ai/dsh-client-runtime/client': fileURLToPath(new URL(
        '../../upstream/deepseek-harness/packages/client/runtime/src/client/index.ts',
        import.meta.url,
      )),
    },
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
