import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { clientBundle } from '../../upstream/deepseek-harness/packages/client/tsdown.client.ts'

const require = createRequire(import.meta.url)
const excalidrawRoot = dirname(dirname(dirname(require.resolve('@excalidraw/excalidraw'))))
const preset = clientBundle('@e-mate/dsh-plugin-canvas', ['src/index.ts', 'src/contract.ts'])
export default (options: any) => {
  const configs = preset(options)
  const client = configs.find((config: any) => config.name?.endsWith('/client'))
  if (!client) return configs
  const editor = {
    ...client,
    name: '@e-mate/dsh-plugin-canvas/editor',
    entry: { editor: 'src/client/editor.tsx' },
    outDir: 'lib/assets',
    // tsdown 0.22 forces CJS to Node; keep native closure output but resolve browser dependency exports.
    inputOptions: { platform: 'browser', resolve: { conditionNames: ['browser', 'production', 'default'] } },
    define: { ...client.define, 'import.meta.url': 'undefined' },
    outputOptions: { ...client.outputOptions, entryFileNames: 'editor.js', inlineDynamicImports: true,
      banner: 'window.__ModuleLoader__.load({ id: "@e-mate/dsh-plugin-canvas/editor", factory: (require) => {',
    },
    plugins: [...(client.plugins ?? []), {
      name: 'emate-canvas-offline-fonts',
      transform(code: string, id: string) {
        if (!id.includes('/@excalidraw/excalidraw/') || !code.includes('ASSETS_FALLBACK_URL')) return null
        const start = code.indexOf('`https://esm.sh/')
        const end = code.indexOf('/dist/prod/`', start)
        if (start < 0 || end < start || code.indexOf('`https://esm.sh/', start + 1) >= 0) throw new Error('Pinned Excalidraw font fallback changed; offline build refused')
        return { code: code.slice(0, start) + 'new URL("/emate-canvas-assets/",window.location.origin).href' + code.slice(end + '/dist/prod/`'.length), map: null }
      },
      async writeBundle() {
        const packageJson = JSON.parse(await readFile(join(excalidrawRoot, 'package.json'), 'utf8'))
        if (packageJson.version !== '0.18.1') throw new Error('Canvas requires exact Excalidraw 0.18.1')
        await mkdir('lib/assets', { recursive: true })
        await cp(join(excalidrawRoot, 'dist/prod/fonts'), 'lib/assets/fonts', { recursive: true })
        const css = await readFile(join(excalidrawRoot, 'dist/prod/index.css'), 'utf8')
        if (/url\(["']?https?:\/\//u.test(css)) throw new Error('Excalidraw CSS contains a remote resource')
        await writeFile('lib/assets/editor.css', css)
        await cp('licenses', 'lib/licenses', { recursive: true })
        const packages = new Map<string, string>()
        for (const module of this.getModuleIds()) {
          if (!module.includes('/node_modules/') || module.startsWith('\0')) continue
          let directory = dirname(module)
          while (directory.includes('/node_modules/')) {
            try {
              const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
              if (metadata.name) { packages.set(`${metadata.name}@${metadata.version}`, directory); break }
            } catch {}
            const parent = dirname(directory); if (parent === directory) break; directory = parent
          }
        }
        const notices: string[] = []
        for (const [name, directory] of [...packages].sort()) {
          const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
          const names = (await readdir(directory)).filter(name => /^(?:license|licence|copying|notice)(?:\.|$)/iu.test(name))
          notices.push(`\n## ${name}\nDeclared license: ${typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license)}\n`)
          for (const file of names) { try { notices.push(await readFile(join(directory, file), 'utf8')) } catch {} }
        }
        notices.push(await readFile('THIRD_PARTY_NOTICES.md', 'utf8'))
        await writeFile('lib/THIRD_PARTY_NOTICES.txt', notices.join('\n'))
        const files: { path: string; bytes: number; sha256: string }[] = []
        const scan = async (directory: string, prefix: string) => {
          for (const file of await readdir(directory, { withFileTypes: true })) {
            const path = join(directory, file.name), relative = `${prefix}${file.name}`
            if (file.isDirectory()) await scan(path, relative + '/')
            else if (!file.name.endsWith('.map') && file.name !== 'asset-manifest.json') {
              const bytes = await readFile(path); files.push({ path: relative, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
            }
          }
        }
        await scan('lib/assets', '')
        await writeFile('lib/assets/asset-manifest.json', JSON.stringify({ excalidraw: '0.18.1', files }, null, 2) + '\n')
      },
    }],
  }
  return [...configs, editor]
}
