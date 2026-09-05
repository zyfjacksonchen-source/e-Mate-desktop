import { fileURLToPath } from 'node:url'
const harness = fileURLToPath(new URL('../../upstream/deepseek-harness/', import.meta.url))
export default {
  resolve: { alias: {
    'react-dom': `${harness}/node_modules/.pnpm/node_modules/react-dom`,
    react: `${harness}/node_modules/.pnpm/node_modules/react`,
    '@testing-library/react': `${harness}/node_modules/@testing-library/react`,
  } },
  test: { include: ['test/*.client.spec.tsx'], environment: 'jsdom' },
}
