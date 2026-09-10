const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u
const PINNED_GITHUB = /^github:(?<owner>[A-Za-z0-9-]{1,39})\/(?<repo>[A-Za-z0-9._-]{1,100})#(?<commit>[0-9a-f]{40})$/u
export const OPTIONAL_UNIVER_PACKAGE = '@e-mate/dsh-plugin-univer-office'
export interface PluginArtifactSource {
  readonly kind: 'https-archive'
  readonly version: string
  readonly description: string
  readonly platforms: readonly string[]
  /** Reviewed candidate identity; the immutable URL becomes available through promotion. */
  readonly artifact?: { readonly url: string; readonly sha256: string }
}
export type PluginSource = string | PluginArtifactSource
const PROTECTED_PLUGIN_PREFIXES = ['@deepseek-ai/', '@e-mate/']
const PROTECTED_PLUGIN_NAMES = new Set([
  '@kelearns/dsh-navigation-bar', '@omdsh-dev/dsh-genui', 'dsh-at-file',
  'dsh-better-sidebar', 'dsh-file-viewer', 'dsh-visualize',
])

/** Desktop exposes no inventory query; this is the single optional-package exception. */
export function validatePluginManagement(packageName: string, source?: PluginSource): void {
  validatePluginPackageName(packageName)
  const optionalUniver = packageName === OPTIONAL_UNIVER_PACKAGE && typeof source === 'object'
    && source.kind === 'https-archive' && source.version === '2.0.18'
  if (PROTECTED_PLUGIN_NAMES.has(packageName)
    || PROTECTED_PLUGIN_PREFIXES.some(prefix => packageName.startsWith(prefix)) && !optionalUniver) {
    throw new Error('e-Mate 与 DSH 托管插件不能通过按需插件工具修改。')
  }
}

export function pluginPlatformSupported(source: PluginSource, platform = `${process.platform}-${process.arch}`): boolean {
  return typeof source === 'string' || source.platforms.includes(platform)
}

export function validatePluginPackageName(packageName: string): void {
  if (!PACKAGE_NAME.test(packageName)) throw new Error('DSH 插件包名无效。')
}

export function validatePluginInstall(packageName: string, source: PluginSource): void {
  validatePluginPackageName(packageName)
  if (typeof source !== 'string') {
    if (packageName !== OPTIONAL_UNIVER_PACKAGE || source.kind !== 'https-archive' || source.version !== '2.0.18'
      || source.platforms.length !== 2 || !['darwin-arm64', 'win32-x64'].every(platform => source.platforms.includes(platform))) {
      throw new Error('DSH 插件归档不符合可信可选目录。')
    }
    if (source.artifact === undefined) throw new Error('此可选插件的已审核归档尚未发布，暂不能安装。')
    let url: URL
    try { url = new URL(source.artifact.url) } catch { throw new Error('DSH 插件归档 HTTPS 地址无效。') }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== ''
      || source.artifact.url.length > 8192 || /[\u0000-\u0020\u007f]/u.test(source.artifact.url)
      || !/^[a-f0-9]{64}$/u.test(source.artifact.sha256)) throw new Error('DSH 插件归档需要固定 HTTPS 地址和 SHA256。')
    return
  }
  if (!PINNED_GITHUB.test(source)) {
    throw new Error('DSH 插件只允许从固定 GitHub 提交安装（github:owner/repo#40位SHA）。')
  }
}
