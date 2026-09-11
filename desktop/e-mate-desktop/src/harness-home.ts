/**
 * The Harness home the e-Mate desktop owns.
 *
 * e-Mate keeps every Harness-owned artifact in its own home: the product profile, the
 * sessions, the settings document (theme, language, default model), the credentials, the
 * attachments and the plugin data. That home has always been `~/.dsh`, and installed
 * upgrades keep using it.
 *
 * An ambient `DSH_HOME` belongs to whichever process launched the app - a locally installed
 * DeepSeek Harness application, a Desktop Terminal, a shell profile, or any tool that
 * exports it. Inheriting that value silently redirects the whole product into another
 * application's home: its sessions appear in e-Mate, and e-Mate's profile install writes its
 * theme and default model into that application's settings document. The desktop therefore
 * resolves its home itself and pins `DSH_HOME` to it for the Harness it boots, so the
 * Harness, its plugins, its child processes and the Desktop Terminal all stay inside the
 * product's own home.
 *
 * `EMATE_DSH_HOME` is the product's own override and the only value that may move the home.
 *
 * @module @e-mate/desktop/harness-home
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment variable that moves the e-Mate Harness home deliberately. */
export const EMATE_DSH_HOME_ENV = 'EMATE_DSH_HOME'

/** Environment variable the pinned Harness reads for its home. */
export const HARNESS_HOME_ENV = 'DSH_HOME'

/** Directory name of the product's own Harness home under the operating-system home. */
const DEFAULT_HARNESS_HOME_DIR = '.dsh'

/** One resolved home plus the ambient value that had to be discarded. */
export interface PinnedHarnessHome {
  /** Absolute Harness home this process must use. */
  readonly home: string
  /** An inherited `DSH_HOME` that was ignored because it named a different home. */
  readonly ignored?: string
}

/** Expand a leading `~` against the operating-system home. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/**
 * The product's own Harness home.
 * @param environment - process environment carrying a possible `EMATE_DSH_HOME` override.
 * @returns the absolute home path.
 */
export function emateHarnessHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment[EMATE_DSH_HOME_ENV]
  const requested = configured !== undefined && configured.trim().length > 0
    ? configured
    : DEFAULT_HARNESS_HOME_DIR
  return resolve(expandHome(requested.startsWith('~') || requested.startsWith('/') ? requested : join(homedir(), requested)))
}

/**
 * Resolve the product's Harness home and pin it into the environment.
 *
 * The pin is what keeps the booted Harness, its plugins and every child process inside the
 * product's home even when the launcher exported a foreign `DSH_HOME`.
 * @param environment - process environment to read the override from and to pin into.
 * @returns the resolved home and, when one was discarded, the inherited value.
 */
export function pinHarnessHome(environment: NodeJS.ProcessEnv = process.env): PinnedHarnessHome {
  const home = emateHarnessHome(environment)
  const inherited = environment[HARNESS_HOME_ENV]
  const ignored = inherited !== undefined && inherited.trim().length > 0 && resolve(expandHome(inherited)) !== home
    ? inherited
    : undefined
  environment[HARNESS_HOME_ENV] = home
  return ignored === undefined ? { home } : { home, ignored }
}
