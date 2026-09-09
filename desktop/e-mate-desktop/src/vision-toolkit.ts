import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Base ABI for the architecture-matched Python shipped beside app.asar. */
export function bundledPythonPath(): string {
  const target = `${process.platform}-${process.arch}`
  const relative = process.platform === 'win32'
    ? join('python-runtime', target, 'python', 'python.exe')
    : join('python-runtime', target, 'python', 'bin', 'python3')
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const packaged = resourcesPath === undefined ? undefined : join(resourcesPath, relative)
  if (packaged !== undefined && existsSync(packaged)) return packaged
  return join(dirname(dirname(fileURLToPath(import.meta.url))), 'build', relative)
}
