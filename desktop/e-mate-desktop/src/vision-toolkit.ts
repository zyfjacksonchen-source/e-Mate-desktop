import { existsSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Shared Calc font discovery; the caller owns this private directory's lifetime. */
export async function prepareCalcFontEnvironment(fontDirectory: string, directory: string, signal?: AbortSignal): Promise<NodeJS.ProcessEnv> {
  const escape = (value: string): string => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;')
  const cache = join(directory, 'font-cache')
  const config = join(directory, 'fonts.conf')
  await mkdir(cache, { recursive: true })
  await writeFile(config, `<?xml version="1.0"?><fontconfig><dir>${escape(fontDirectory)}</dir><cachedir>${escape(cache)}</cachedir><alias><family>Calibri</family><prefer><family>Noto Sans SC</family></prefer></alias><alias><family>sans-serif</family><prefer><family>Noto Sans SC</family></prefer></alias></fontconfig>`, { flag: 'wx', mode: 0o600, signal })
  return { FONTCONFIG_FILE: config, FONTCONFIG_PATH: directory }
}

/** Host-only defaults inherited by native subprocesses; never changes system configuration. */
export async function installCalcFontEnvironment(fontDirectory: string, environment: NodeJS.ProcessEnv): Promise<() => Promise<void>> {
  // Respect explicit platform/user configuration, including Windows' case-insensitive keys.
  if (Object.entries(environment).some(([key, value]) => value !== undefined && ['FONTCONFIG_FILE', 'FONTCONFIG_PATH'].includes(key.toUpperCase()))) return async () => {}
  const directory = await mkdtemp(join(tmpdir(), 'emate-calc-fonts-'))
  let values: NodeJS.ProcessEnv
  try { values = await prepareCalcFontEnvironment(fontDirectory, directory) }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  Object.assign(environment, values)
  return async () => {
    for (const [key, value] of Object.entries(values)) if (environment[key] === value) delete environment[key]
    await rm(directory, { recursive: true, force: true })
  }
}

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
