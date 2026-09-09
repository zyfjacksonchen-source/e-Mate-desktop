/** Immutable Main-to-Preload identity for one e-Mate Renderer. */

export const DESKTOP_BOOTSTRAP_BRIDGE = '__EMATE_DESKTOP_BOOTSTRAP__'
export const DESKTOP_BOOTSTRAP_ARGUMENT = '--e-mate-desktop-bootstrap='

export type DesktopBootstrapMode = 'compatibility' | 'advanced'
export type DesktopBootstrapPlatform = 'darwin' | 'win32' | 'linux'
export type DesktopWindowKind = 'main'

export interface DesktopRendererBootstrap {
  readonly schemaVersion: 1
  readonly mode: DesktopBootstrapMode
  readonly platform: DesktopBootstrapPlatform
  readonly profileGeneration: 'bundled'
  readonly runtimeId: string
  readonly windowKind: DesktopWindowKind
}

const MODES = new Set<DesktopBootstrapMode>(['compatibility', 'advanced'])
const PLATFORMS = new Set<DesktopBootstrapPlatform>(['darwin', 'win32', 'linux'])
const IDENTIFIER = /^[A-Za-z0-9._:-]{1,128}$/u

/** Validate data before it crosses either side of the context-isolation boundary. */
export function validateDesktopRendererBootstrap(value: unknown): DesktopRendererBootstrap {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('@e-mate/desktop: Renderer bootstrap must be an object')
  }
  const candidate = value as Partial<DesktopRendererBootstrap>
  if (candidate.schemaVersion !== 1
    || !MODES.has(candidate.mode as DesktopBootstrapMode)
    || !PLATFORMS.has(candidate.platform as DesktopBootstrapPlatform)
    || candidate.profileGeneration !== 'bundled'
    || !IDENTIFIER.test(candidate.runtimeId ?? '')
    || candidate.windowKind !== 'main') {
    throw new Error('@e-mate/desktop: invalid Renderer bootstrap')
  }
  return candidate as DesktopRendererBootstrap
}

/** Encode one validated bootstrap as an Electron additional argument. */
export function desktopRendererBootstrapArgument(value: DesktopRendererBootstrap): string {
  return `${DESKTOP_BOOTSTRAP_ARGUMENT}${encodeURIComponent(JSON.stringify(validateDesktopRendererBootstrap(value)))}`
}

/** Read the one Main-owned bootstrap visible to a sandboxed Preload. */
export function parseDesktopRendererBootstrapArgument(argv: readonly string[]): DesktopRendererBootstrap {
  const values = argv.filter(value => value.startsWith(DESKTOP_BOOTSTRAP_ARGUMENT))
  if (values.length !== 1) throw new Error('@e-mate/desktop: expected one Renderer bootstrap argument')
  const encoded = values[0]!.slice(DESKTOP_BOOTSTRAP_ARGUMENT.length)
  try {
    return validateDesktopRendererBootstrap(JSON.parse(decodeURIComponent(encoded)))
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith('@e-mate/desktop:')) throw cause
    throw new Error('@e-mate/desktop: malformed Renderer bootstrap argument', { cause })
  }
}

export interface DesktopBootstrapWindow {
  __EMATE_DESKTOP_BOOTSTRAP__?: DesktopRendererBootstrap
}

/** Narrow, main-owned notification navigation through the existing preload boundary. */
export const DESKTOP_NOTIFICATION_BRIDGE = '__EMATE_DESKTOP_NOTIFICATION__'
export const DESKTOP_NOTIFICATION_OPEN = 'emate:desktop-notification-open'
export const DESKTOP_NOTIFICATION_TAKE = 'emate:desktop-notification-take'
export interface DesktopNotificationBridge {
  subscribe(listener: (sessionId: string) => void): () => void
}
