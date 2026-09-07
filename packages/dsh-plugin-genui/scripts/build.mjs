import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, '../../upstream/plugins/dsh-genui')
const output = resolve(root, 'lib')
const upstreamId = '@omdsh-dev/dsh-genui'
const packageId = '@e-mate/dsh-plugin-genui'
const domFenceFallback = 'console.info(`[genui] fence-registry 扩展点不存在（原版 DSH）——启用 DOM 渲染通道`),[Gn(e,(t,n,r)=>tr(e,t,n,r))]'
const assetPathSeam = 'pathname.startsWith(`${ASSET_ROUTE_PATH}/`) ? pathname.slice(36) : null'

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(resolve(source, 'lib'), output, { recursive: true })

for (const relative of ['index.js', 'client.js', 'invariant.js']) {
  const path = resolve(output, relative)
  let built = await readFile(path, 'utf8')
  if (relative === 'index.js') {
    // Upstream folded its package-specific route length before our ID adaptation.
    if (built.split(assetPathSeam).length !== 2) throw new Error('pinned GenUI asset path seam changed')
    built = built.replace(assetPathSeam, 'pathname.startsWith(`${ASSET_ROUTE_PATH}/`) ? pathname.slice(ASSET_ROUTE_PATH.length) : null')
  }
  if (relative === 'client.js') {
    if (!built.includes(domFenceFallback)) throw new Error('pinned GenUI DOM fallback seam changed')
    // rc.7 has no fence registry: preserve the upstream DOM renderer alongside ToolView.
  }
  await writeFile(path, built.replaceAll(upstreamId, packageId))
}

await cp(resolve(source, 'SKILL.md'), resolve(root, 'SKILL.md'))
await cp(resolve(source, 'LICENSE'), resolve(root, 'LICENSE'))
