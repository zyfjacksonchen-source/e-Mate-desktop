import { clientBundle } from '../../upstream/deepseek-harness/packages/client/tsdown.client.ts'

// fflate and yaml are development dependencies, so the preset's own
// neverBundle/alwaysBundle contract already inlines them; rc.1's tsdown rejects
// the rc.7 noExternal override once the preset states both halves.
export default clientBundle('@e-mate/dsh-plugin-skill-hub', ['src/index.ts', 'src/skill-hub.ts'])
