import { fileURLToPath } from 'node:url'
const modules = fileURLToPath(new URL('../../upstream/deepseek-harness/node_modules/', import.meta.url))
export default {
  esbuild: { jsx: 'automatic' },
  test: { include: ['test/*.client.spec.tsx'], fileParallelism: false },
  resolve: { alias: { react: `${modules}.pnpm/node_modules/react`, 'react-dom': `${modules}.pnpm/node_modules/react-dom`, '@testing-library/react': `${modules}@testing-library/react` } },
}
