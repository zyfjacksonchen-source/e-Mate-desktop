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
// Client plugin packages emit browser bundles that install themselves through
// window.__ModuleLoader__, which jsdom does not provide. Specs therefore reach
// their SOURCE entry, exactly as the removed client-runtime alias did.
const upstreamRenderer = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-renderer/src/client/index.ts',
  import.meta.url,
))
const upstreamUiSession = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-session/src/client/index.ts',
  import.meta.url,
))
const upstreamSessionController = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/api/session-controller/src/client/index.ts',
  import.meta.url,
))
const upstreamUiConversation = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-conversation/src/client/index.ts',
  import.meta.url,
))
const upstreamUiChat = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/client/ui-chat/src/client/index.ts',
  import.meta.url,
))
// Reached through api-gateway/client, which node resolution cannot satisfy from
// the shell's tree; the built lib is the shipped artifact.
const upstreamApiGateway = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/api/gateway/src/client/index.ts',
  import.meta.url,
))
const upstreamTypertProtocol = fileURLToPath(new URL(
  '../../../../../upstream/deepseek-harness/packages/typert/protocol/lib/index.js',
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
      '@deepseek-ai/dsh-client-ui-renderer/client': upstreamRenderer,
      '@deepseek-ai/dsh-client-ui-session/client': upstreamUiSession,
      '@deepseek-ai/dsh-api-session-controller/client': upstreamSessionController,
      '@deepseek-ai/dsh-client-ui-conversation/client': upstreamUiConversation,
      '@deepseek-ai/dsh-client-ui-chat/client': upstreamUiChat,
      '@deepseek-ai/dsh-api-gateway/client': upstreamApiGateway,
      '@deepseek-ai/dsh-typert-protocol': upstreamTypertProtocol,
      '@deepseek-ai/cordis': upstreamCordis,
    },
  },
}
