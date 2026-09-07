import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { clientBundle } from '../../upstream/deepseek-harness/packages/client/tsdown.client.ts'
const preset = clientBundle('@e-mate/dsh-plugin-knowledge', ['src/index.ts', 'src/contract.ts'])
export default (options: any) => {
  const configs = preset(options)
  const client = configs.find((config: any) => config.name?.endsWith('/client'))
  if (!client) return configs
  return [...configs, {
    ...client, name: '@e-mate/dsh-plugin-knowledge/graph',
    entry: { graph: 'src/client/graph-renderer.ts' }, outDir: 'lib/assets',
    inputOptions: { platform: 'browser', resolve: { conditionNames: ['browser', 'production', 'default'] } },
    define: { ...client.define, 'import.meta.url': 'undefined' },
    plugins: [...(client.plugins ?? []), { name: 'emate-knowledge-three-license', async writeBundle() {
      const version = JSON.parse(await readFile(new URL('./node_modules/three/package.json', import.meta.url), 'utf8')).version
      if (version !== '0.185.1') throw Error('Knowledge graph requires pinned Three 0.185.1')
      await mkdir('lib/licenses', { recursive: true })
      await copyFile(new URL('./node_modules/three/LICENSE', import.meta.url), 'lib/licenses/three.LICENSE.txt')
    } }],
    outputOptions: { ...client.outputOptions, entryFileNames: 'graph.js', inlineDynamicImports: true,
      banner: 'window.__ModuleLoader__.load({ id: "@e-mate/dsh-plugin-knowledge/graph", factory: (require) => {',
    },
  }]
}
