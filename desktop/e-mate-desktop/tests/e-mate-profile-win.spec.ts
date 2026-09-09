import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { installEmateDesktopProfile } from '../src/e-mate-profile.ts'

const roots: string[] = []

afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.runIf(process.platform === 'win32')('Windows managed Profile materialization', () => {
  let home: string
  let profile: string
  // Cold fixture installation and the repair assertions are separate bounded
  // phases. Combining all five physical operations exceeded 120s on Windows;
  // neither deadline is a product startup or repair latency budget.
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'e-mate-desktop-profile-win-'))
    roots.push(home)
    profile = installEmateDesktopProfile(home)
  }, 120_000)

  it('uses physical directories and repairs a missing declared main without scanning unrelated nested files', () => {
    const receiptPath = join(profile, '.e-mate-install.json')
    const packageRoot = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-schedules')
    const computerUseRoot = join(profile, 'node_modules', '@e-mate', 'dsh-plugin-computer-use')
    const computerUsePatch = readFileSync(join(computerUseRoot, 'cordis.patch.yml'), 'utf8')
    expect((computerUsePatch.match(/id: emate-computer-use/gu) ?? []).length).toBe(1)
    expect(computerUsePatch).toContain("disabled: !!js Array.of('darwin', 'win32').includes(process.platform) === false")
    expect(computerUsePatch).toContain("process.platform === 'win32' ? 'hidden' : 'visible'")
    const publicTypes = readFileSync(join(computerUseRoot, 'lib', 'types', 'types.d.ts'), 'utf8')
    expect(publicTypes).not.toMatch(/executablePath|processStartTime|windowId/u)
    expect(existsSync(join(computerUseRoot, 'native', 'windows', 'dsh-computer-use-helper.ps1'))).toBe(true)
    expect(existsSync(join(computerUseRoot, 'native', 'windows', 'manifest.json'))).toBe(true)
    const library = join(packageRoot, 'lib')
    const main = join(library, 'index.js')
    const nestedExtra = join(library, '.warm-path-does-not-scan-this-file')
    const topLevelExtra = join(packageRoot, '.unexpected-top-level-entry')
    const unrelatedNestedExtra = join(computerUseRoot, 'lib', '.unrelated-package-warm-marker')
    const receipt = readFileSync(receiptPath, 'utf8')

    // The shipped process enforces Windows redirection trust, so managed payloads cannot rely on junctions.
    expect(lstatSync(packageRoot).isSymbolicLink()).toBe(false)
    expect(lstatSync(library).isSymbolicLink()).toBe(false)
    writeFileSync(nestedExtra, 'warm launch must not recurse through the package tree')
    writeFileSync(unrelatedNestedExtra, 'repairing schedules must not rescan unrelated package payloads')
    installEmateDesktopProfile(home)
    expect(readFileSync(receiptPath, 'utf8')).toBe(receipt)
    expect(existsSync(nestedExtra)).toBe(true)

    rmSync(main)
    installEmateDesktopProfile(home)
    expect(existsSync(main)).toBe(true)
    expect(existsSync(nestedExtra)).toBe(false)
    expect(existsSync(unrelatedNestedExtra)).toBe(true)
    expect(lstatSync(library).isSymbolicLink()).toBe(false)

    writeFileSync(topLevelExtra, 'managed roots are exact sets')
    installEmateDesktopProfile(home)
    expect(existsSync(topLevelExtra)).toBe(false)
    expect(existsSync(unrelatedNestedExtra)).toBe(true)

    // An absent generation receipt cannot authorize bounded package reuse.
    rmSync(receiptPath)
    installEmateDesktopProfile(home)
    expect(existsSync(unrelatedNestedExtra)).toBe(false)
  }, 120_000)
})
