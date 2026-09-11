// Shared browser-resolution aliases for e-Mate component specs.
//
// rc.1 client plugin packages emit browser bundles that install themselves
// through window.__ModuleLoader__, which jsdom does not provide, so a spec must
// reach each package's SOURCE entry. The removed client-runtime and
// client-web-react packages left stale aliases behind; keeping one table here
// means every component resolves the same graph the same way.
import { fileURLToPath } from 'node:url'

const harness = (path) => fileURLToPath(new URL(`../upstream/deepseek-harness/${path}`, import.meta.url))
const modules = harness('node_modules/')

export const emateClientTestAliases = {
  'react-dom': `${modules}.pnpm/node_modules/react-dom`,
  react: `${modules}.pnpm/node_modules/react`,
  '@testing-library/react': `${modules}@testing-library/react`,
  '@deepseek-ai/cordis': harness('vendor/cordis/lib/index.js'),
  '@deepseek-ai/dsh-client-ui-primitives': harness('packages/client/ui-primitives/lib/index.js'),
  '@deepseek-ai/dsh-client-ui-attachment': harness('packages/client/ui-attachment/lib/index.js'),
  '@deepseek-ai/dsh-client-ui-renderer/client': harness('packages/client/ui-renderer/src/client/index.ts'),
  '@deepseek-ai/dsh-client-ui-session/client': harness('packages/client/ui-session/src/client/index.ts'),
  '@deepseek-ai/dsh-client-locale/client': harness('packages/client/locale/src/client/index.ts'),
  '@deepseek-ai/dsh-client-store': harness('packages/client/store/src/index.ts'),
  '@deepseek-ai/dsh-api-session-controller/client': harness('packages/api/session-controller/src/client/index.ts'),
  '@deepseek-ai/dsh-client-ui-conversation/client': harness('packages/client/ui-conversation/src/client/index.ts'),
  '@deepseek-ai/dsh-client-ui-chat/client': harness('packages/client/ui-chat/src/client/index.ts'),
  '@deepseek-ai/dsh-api-gateway/client': harness('packages/api/gateway/src/client/index.ts'),
  '@deepseek-ai/dsh-typert-protocol': harness('packages/typert/protocol/lib/index.js'),
}
