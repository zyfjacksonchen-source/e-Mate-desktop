import { expect, it } from 'vitest'
import { join } from 'node:path'
import { bundledPythonPath } from '../src/vision-toolkit.ts'

it('exports only the architecture-matched Vision Python carrier', () => {
  const executable = process.platform === 'win32' ? ['python.exe'] : ['bin', 'python3']
  expect(bundledPythonPath().endsWith(join('python-runtime', `${process.platform}-${process.arch}`, 'python', ...executable))).toBe(true)
})
