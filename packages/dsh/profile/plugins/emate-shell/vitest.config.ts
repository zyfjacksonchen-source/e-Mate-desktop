import { emateClientTestAliases } from '../../../../../scripts/emate-client-test-aliases.mjs'

export default {
  esbuild: { jsx: 'automatic' },
  test: { fileParallelism: false },
  resolve: { alias: emateClientTestAliases },
}
