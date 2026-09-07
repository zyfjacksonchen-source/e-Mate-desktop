import { fileURLToPath } from 'node:url'

const upstreamModules = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/node_modules/',
  import.meta.url,
))
const upstreamPrimitives = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-primitives/lib/index.js',
  import.meta.url,
))
const upstreamRuntime = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/runtime/src/client/index.ts',
  import.meta.url,
))
const upstreamAttachment = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-attachment/lib/index.js',
  import.meta.url,
))
const upstreamCordis = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/vendor/cordis/lib/index.js',
  import.meta.url,
))

export default {
  esbuild: { jsx: 'automatic' },
  test: { fileParallelism: false },
  resolve: {
    alias: {
      'react-dom': `${upstreamModules}.pnpm/node_modules/react-dom`,
      react: `${upstreamModules}.pnpm/node_modules/react`,
      '@testing-library/react': `${upstreamModules}@testing-library/react`,
      '@deepseek-ai/dsh-client-ui-primitives': upstreamPrimitives,
      '@deepseek-ai/dsh-client-ui-attachment': upstreamAttachment,
      '@deepseek-ai/dsh-client-runtime/client': upstreamRuntime,
      '@deepseek-ai/dsh-client-web-react': fileURLToPath(new URL('../../../../../upstream/deepseek-harness/packages/client/web-react/src/index.ts', import.meta.url)),
      '@deepseek-ai/cordis': upstreamCordis,
    },
  },
}
