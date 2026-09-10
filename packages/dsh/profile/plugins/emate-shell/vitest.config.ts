import { fileURLToPath } from 'node:url'

const upstreamModules = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/node_modules/',
  import.meta.url,
))
const upstreamPrimitives = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-primitives/lib/index.js',
  import.meta.url,
))
// 0.1.5 removed @deepseek-ai/dsh-client-runtime and dsh-client-web-react. Their
// aliases named source paths that no longer exist, which broke resolution for
// every transitive import in the suite.
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
      '@deepseek-ai/cordis': upstreamCordis,
    },
  },
}
