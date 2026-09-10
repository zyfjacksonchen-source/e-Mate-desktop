import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

const root = join(import.meta.dirname, '..')
const json = path => JSON.parse(readFileSync(join(root, path), 'utf8'))

test('keeps current e-Mate source owners on 2.0.18', () => {
  const pluginManifests = readdirSync(join(root, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('dsh-plugin-'))
    .map(entry => join('packages', entry.name, 'package.json'))
  for (const path of [
    'package.json',
    'enterprise/package.json',
    'desktop/package.json',
    'desktop/e-mate-desktop/package.json',
    'packages/dsh/package.json',
    'packages/dsh/profile/plugins/emate-shell/package.json',
    ...pluginManifests,
  ]) assert.equal(json(path).version, '2.0.18', path)

  const contract = json('desktop/e-mate-desktop/base-contract.json')
  assert.equal(contract.id, 'e-mate-desktop-profile-v18-dsh-4da69d7c3522')
  assert.equal(contract.runtime_imports['@e-mate/desktop/vision-toolkit'], '2.0.18')
  assert.equal(contract.harness_version, '0.1.0-rc.7')
  assert.equal(json('package.json').packageManager, 'pnpm@11.8.0')
  assert.equal(json('desktop/package.json').packageManager, 'yarn@4.18.0')
})

test('keeps active Desktop guidance out of root Corepack', () => {
  for (const path of [
    'AGENTS.md',
    'README.md',
    'docs/target-contract.md',
    'docs/environment-and-dependencies.md',
    'desktop/e-mate-desktop/README.md',
    'desktop/e-mate-desktop/README.zh.md',
  ]) assert.doesNotMatch(readFileSync(join(root, path), 'utf8'), /corepack yarn --cwd desktop/u, path)
})

test('keeps public download pointers on 2.0.16', () => {
  for (const path of ['deploy/download-page/index.html', 'deploy/download-page/install-macos.html']) {
    const html = readFileSync(join(root, path), 'utf8')
    assert.match(html, /data-desktop-version="2\.0\.16"/u, path)
    assert.doesNotMatch(html, /data-desktop-version="2\.0\.18"/u, path)
  }
})
