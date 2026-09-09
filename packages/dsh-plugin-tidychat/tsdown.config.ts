import { clientBundle } from '../../upstream/deepseek-harness/packages/client/tsdown.client.ts'

export default clientBundle('@e-mate/dsh-plugin-tidychat', ['src/index.ts'], {
  lib: { deps: { neverBundle: [/^@deepseek-ai\//], onlyBundle: false } },
})
