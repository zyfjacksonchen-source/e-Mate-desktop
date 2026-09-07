import { fileURLToPath } from 'node:url'
const harness = fileURLToPath(new URL('../../upstream/deepseek-harness/', import.meta.url))
export default {
  resolve: { alias: {
    '@deepseek-ai/dsh-client-ui-slots': `${harness}/packages/client/ui-slots/src/index.ts`,
    '@deepseek-ai/dsh-client-web-react': `${harness}/packages/client/web-react/src/index.ts`,
    'react-dom': `${harness}/node_modules/.pnpm/node_modules/react-dom`,
    react: `${harness}/node_modules/.pnpm/node_modules/react`,
    '@testing-library/react': `${harness}/node_modules/@testing-library/react`,
  } },
  test: { include: ['test/*.client.spec.tsx'], environment: 'jsdom' },
}
