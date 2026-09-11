#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prepareHarnessBaseImports } from './component-base-imports.mjs'

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { component: { type: 'string' } },
})
const command = positionals[0]
if (!['build', 'check'].includes(command) || positionals.length !== 1) {
  throw new Error('usage: node scripts/component-run.mjs <build|check> [--component <id>]')
}

const inventory = JSON.parse(readFileSync(new URL('../packages/dsh/profile/component-inventory.json', import.meta.url), 'utf8'))
const baseContract = JSON.parse(readFileSync(new URL('../desktop/e-mate-desktop/base-contract.json', import.meta.url), 'utf8'))
if (inventory.schema_version !== 1 || !Array.isArray(inventory.components)
  || baseContract.harness_version !== '0.1.5-rc.1'
  || baseContract.harness_commit !== 'bf7179bf3f62585d84b9b41b8cc1a0fffa1d7866') {
  throw new Error('bundled Profile inventory or pinned Base contract is invalid')
}
const components = inventory.components.filter(component => component.desktop !== 'blocked'
  && (values.component === undefined || component.id === values.component))
if (components.length === 0 || values.component !== undefined && components.length !== 1) {
  throw new Error(`unknown or blocked component: ${String(values.component)}`)
}

const packageManager = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).packageManager
const expectedPnpm = /^pnpm@([^+]+)$/u.exec(packageManager)?.[1]
if (expectedPnpm === undefined) throw new Error(`unsupported packageManager: ${String(packageManager)}`)
const inheritedPnpm = process.env.npm_execpath
const pnpm = inheritedPnpm === undefined
  ? { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', prefix: [], shell: process.platform === 'win32' }
  : { command: process.execPath, prefix: [inheritedPnpm], shell: false }

const detectedPnpm = spawnSync(pnpm.command, [...pnpm.prefix, '--version'], { encoding: 'utf8', shell: pnpm.shell })
if (detectedPnpm.error !== undefined) throw detectedPnpm.error
if (detectedPnpm.status !== 0) throw new Error(detectedPnpm.stderr.trim() || 'unable to determine pnpm version')
if (detectedPnpm.stdout.trim() !== expectedPnpm) {
  throw new Error(`component builds require pnpm ${expectedPnpm}, found ${detectedPnpm.stdout.trim()}`)
}

function run(args, env = process.env) {
  const result = spawnSync(pnpm.command, [...pnpm.prefix, ...args], { stdio: 'inherit', env, shell: pnpm.shell })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

for (const component of components) {
  const manifest = JSON.parse(readFileSync(resolve(component.root, 'package.json'), 'utf8'))
  if (manifest.name !== component.id || manifest.version !== '2.0.18'
    || manifest.eMate?.harnessVersion !== '0.1.5-rc.1'
    || !Array.isArray(manifest.eMate?.baseImports)) {
    throw new Error(`bundled Profile package identity is invalid: ${component.id}`)
  }
  // A component-local workspace owns its native patch configuration. Otherwise
  // isolate installation from the repository workspace as before.
  const localWorkspace = existsSync(resolve(component.root, 'pnpm-workspace.yaml'))
  run(['--dir', component.root, 'install', ...(localWorkspace ? [] : ['--ignore-workspace']), '--frozen-lockfile',
    // The official Feishu binary installer runs under the target Desktop slice
    // in afterPack; running its postinstall here would select the build host.
    ...(component.id === '@e-mate/dsh-plugin-mcp-manage' ? ['--ignore-scripts'] : []),
  ])
  if (component.id === '@e-mate/dsh-plugin-find-skill') {
    run(['--dir', 'upstream/plugins/dsh-find-skill', 'install', '--frozen-lockfile', '--ignore-scripts'])
  }
  prepareHarnessBaseImports({
    componentRoot: resolve(component.root),
    harnessRoot: resolve('upstream/deepseek-harness'),
    baseImports: manifest.eMate.baseImports,
    runtimeImports: baseContract.runtime_imports,
  })
}

for (const component of components) {
  const manifest = JSON.parse(readFileSync(resolve(component.root, 'package.json'), 'utf8'))
  run(['--config.shell-emulator=true', '--dir', component.root, 'run', 'build'], command === 'check'
    ? { ...process.env, EMATE_COMPONENT_CHECK: '1' }
    : process.env)
  if (command === 'check') run(['--config.shell-emulator=true', '--dir', component.root, 'run', 'test'])
  // A component that declares a typecheck script owns a compiler face; tsdown only
  // transpiles, so without this step stale native reads stay invisible to the gate.
  if (command === 'check' && manifest.scripts?.typecheck !== undefined) {
    run(['--config.shell-emulator=true', '--dir', component.root, 'run', 'typecheck'])
  }
}
