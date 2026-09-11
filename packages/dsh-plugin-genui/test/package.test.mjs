import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('preserves the pinned GenUI Tool, Skill, and client surfaces on the rc.7 component', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  assert.equal(manifest.name, '@e-mate/dsh-plugin-genui')
  assert.equal(manifest.eMate.harnessVersion, '0.1.5-rc.1')
  assert.equal(manifest.eMate.harnessCommit, 'f9e0f1190e4021e63db579ef36b67484028e8c53')
  assert.equal(manifest.peerDependencies, undefined)

  const host = await readFile(resolve(root, 'lib/index.js'), 'utf8')
  const client = await readFile(resolve(root, 'lib/client.js'), 'utf8')
  const shippedJs = await Promise.all((await readdir(resolve(root, 'lib')))
    .filter(name => name.endsWith('.js'))
    .map(name => readFile(resolve(root, 'lib', name), 'utf8')))
  const skill = await readFile(resolve(root, 'SKILL.md'), 'utf8')
  assert.match(host, /@e-mate\/dsh-plugin-genui\/assets/)
  assert.match(host, /name: "render_ui"/)
  assert.match(host, /name: "validate_dsh_ui"/)
  assert.match(client, /id:\s*["'`]@e-mate\/dsh-plugin-genui["'`]/)
  assert.match(client, /tool\.call\.toolview/)
  assert.match(client, /key:\s*["'`]render_ui["'`]/)
  assert.match(client, /conversation\.input\.dock/)
  assert.match(client, /\/panel/)
  assert.match(client, /启用 DOM 渲染通道/u)
  assert.doesNotMatch(client, /仅启用原生 ToolView/u)
  assert.match(client, /data-genui-tool/u)
  assert.match(client, /toolFallback/u)
  assert.match(client, /data-genui-error/u)
  assert.doesNotMatch(client, /name:\s*["'`](?:assistant-step|tool-call|context)["'`]/u)
  assert.match(skill, /dsh-ui/u)
  assert.doesNotMatch(shippedJs.join('\n'), /@omdsh-dev\/dsh-genui/)
})

test('serves the renamed package assets through its registered Host route', async () => {
  const { apply } = await import('../lib/index.js')
  const routes = []
  apply({
    systemPrompt: { section() {} },
    reflect: { get: name => name === 'webServer' ? { register: route => routes.push(route) } : undefined },
    on() {},
  })
  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/plugins/@e-mate/dsh-plugin-genui/assets')
  const request = async (url, method = 'GET') => {
    let status, headers, body
    await route.handler({ url, method }, {
      writeHead(code, value) { status = code; headers = value },
      end(value) { body = value },
    })
    return { status, headers, body }
  }

  for (const name of ['mermaid.js', 'three.js']) {
    const expected = await readFile(resolve(root, 'lib', 'assets', name))
    const response = await request(`${route.path}/${name}?rev=package-contract`)
    assert.equal(response.status, 200, name)
    assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
    assert.deepEqual(response.body, expected)
    assert.equal((await request(`${route.path}/${name}`, 'HEAD')).status, 200)
  }
  for (const url of [
    `${route.path}-other/mermaid.js`,
    '/plugins/@omdsh-dev/dsh-genui/assets/mermaid.js',
    `${route.path}/%2E%2E%2Findex.js`,
    `${route.path}/%2E%2E%5Cindex.js`,
    `${route.path}/../index.js`,
    `${route.path}/missing.js`,
  ]) assert.equal((await request(url)).status, 404, url)
  assert.equal((await request(`${route.path}/%ZZ`)).status, 400)
  assert.equal((await request(`${route.path}/mermaid.js`, 'POST')).status, 405)
})
