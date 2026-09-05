import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '..')
const harness = resolve(root, '../../upstream/deepseek-harness')
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
if (pkg.eMate.harnessCommit !== '4da69d7c3522ee51de12822c917c503a124f7a7d' || pkg.eMate.upstreamCommit !== 'f501139cfb155fd46717a79bb1c158da064dce15') throw new Error('Pet source pin mismatch')
await rm(join(root, 'lib'), { recursive: true, force: true })
const result = spawnSync(process.execPath, [join(harness, 'node_modules/tsdown/dist/run.mjs'), '--config', join(root, 'tsdown.config.ts')], { cwd: root, encoding: 'utf8' })
if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`)
await mkdir(join(root, 'lib/assets'), { recursive: true })
let copied = 0
for (const file of ['xiaoxin-v2.json', 'xiaoxin-v2.webp', 'xiaoxin-office.json', 'xiaoxin-office.webp']) {
  try { await cp(join(root, 'assets', file), join(root, 'lib/assets', file)); copied += 1 }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
console.log(JSON.stringify({ module: 'pet', build: 'ok', assetFiles: copied, assetProduction: copied === 4 ? 'requires-validation' : 'pending' }))
