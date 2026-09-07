import { existsSync, statSync } from 'node:fs'
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

/** Optional until Desktop has prepared the architecture-matched Calc assets. */
export function bundledCalcPaths(): { executable: string; fontDirectory: string } | undefined {
  const target = `${process.platform}-${process.arch}`
  if (!['darwin-arm64', 'darwin-x64', 'win32-x64'].includes(target)) return undefined
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath
  const root = join(resourcesPath ?? join(dirname(dirname(fileURLToPath(import.meta.url))), 'build'), 'calc-runtime')
  const executable = process.platform === 'win32'
    ? join(root, target, 'LibreOffice', 'program', 'soffice.exe')
    : join(root, target, 'LibreOffice.app', 'Contents', 'MacOS', 'soffice')
  const fontDirectory = join(root, 'fonts')
  try {
    if (!statSync(executable).isFile() || !statSync(fontDirectory).isDirectory()) return undefined
    return { executable, fontDirectory }
  } catch { return undefined }
}
