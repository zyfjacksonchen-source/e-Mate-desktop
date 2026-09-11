import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  emateHarnessHome,
  EMATE_DSH_HOME_ENV,
  HARNESS_HOME_ENV,
  pinHarnessHome,
} from '../src/harness-home.ts'

const DEFAULT_HOME = join(homedir(), '.dsh')

describe('the e-Mate Harness home', () => {
  it('defaults to the product home and never to the launcher home', () => {
    expect(emateHarnessHome({})).toBe(DEFAULT_HOME)
    // A launcher that exports DSH_HOME must not move the product: the ambient value names
    // another application's home, where its sessions and its settings document live.
    expect(emateHarnessHome({ [HARNESS_HOME_ENV]: '/other/app/home' })).toBe(DEFAULT_HOME)
  })

  it('honours the product override, including a tilde path, and ignores a blank one', () => {
    expect(emateHarnessHome({ [EMATE_DSH_HOME_ENV]: '/srv/emate-home' })).toBe('/srv/emate-home')
    expect(emateHarnessHome({ [EMATE_DSH_HOME_ENV]: '~/emate-home' })).toBe(join(homedir(), 'emate-home'))
    expect(emateHarnessHome({ [EMATE_DSH_HOME_ENV]: '   ' })).toBe(DEFAULT_HOME)
  })

  it('pins the resolved home into DSH_HOME and reports the inherited value it discarded', () => {
    const environment: NodeJS.ProcessEnv = { [HARNESS_HOME_ENV]: '/Users/someone/Library/Application Support/DeepSeek Harness Official/home' }
    const pinned = pinHarnessHome(environment)
    expect(pinned.home).toBe(DEFAULT_HOME)
    expect(pinned.ignored).toBe('/Users/someone/Library/Application Support/DeepSeek Harness Official/home')
    // The pin is what keeps the booted Harness, its plugins and every child process inside
    // the product's own home.
    expect(environment[HARNESS_HOME_ENV]).toBe(DEFAULT_HOME)
  })

  it('does not report an inherited value that already names the product home', () => {
    const environment: NodeJS.ProcessEnv = { [HARNESS_HOME_ENV]: DEFAULT_HOME }
    const pinned = pinHarnessHome(environment)
    expect(pinned).toEqual({ home: DEFAULT_HOME })
    expect(environment[HARNESS_HOME_ENV]).toBe(DEFAULT_HOME)

    const tilde: NodeJS.ProcessEnv = { [HARNESS_HOME_ENV]: '~/.dsh' }
    expect(pinHarnessHome(tilde).ignored).toBeUndefined()
  })

  it('lets the product override win over an inherited DSH_HOME', () => {
    const environment: NodeJS.ProcessEnv = {
      [EMATE_DSH_HOME_ENV]: '/srv/emate-home',
      [HARNESS_HOME_ENV]: '/other/app/home',
    }
    const pinned = pinHarnessHome(environment)
    expect(pinned.home).toBe('/srv/emate-home')
    expect(pinned.ignored).toBe('/other/app/home')
    expect(environment[HARNESS_HOME_ENV]).toBe('/srv/emate-home')
  })
})
