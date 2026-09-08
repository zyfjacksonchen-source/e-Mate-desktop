import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { bundledCalcPaths, bundledPythonPath } from '../src/vision-toolkit.ts'

it('exports only the architecture-matched Vision Python carrier', () => {
  const executable = process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']
  expect(bundledPythonPath().endsWith(join('python-runtime', `${process.platform}-${process.arch}`, 'python', ...executable))).toBe(true)
})

it('exposes Calc only when this packaged target and its fonts both exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'emate-calc-paths-'))
  const original = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: root })
  try {
    expect(bundledCalcPaths()).toBeUndefined()
    const target = `${process.platform}-${process.arch}`
    if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) return
    const executable = process.platform === 'win32'
      ? join(root, 'calc-runtime', target, 'LibreOffice', 'program', 'soffice.exe')
      : join(root, 'calc-runtime', target, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')
    mkdirSync(dirname(executable), { recursive: true }); writeFileSync(executable, '')
    expect(bundledCalcPaths()).toBeUndefined()
    const fontDirectory = join(root, 'calc-runtime', 'fonts')
    mkdirSync(fontDirectory)
    expect(bundledCalcPaths()).toEqual({ executable, fontDirectory })
    rmSync(executable)
    expect(bundledCalcPaths()).toBeUndefined()
  } finally {
    if (original) Object.defineProperty(process, 'resourcesPath', original)
    else Reflect.deleteProperty(process, 'resourcesPath')
    rmSync(root, { recursive: true, force: true })
  }
})
