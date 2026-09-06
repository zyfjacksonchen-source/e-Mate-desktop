import { readFileSync, readdirSync } from 'node:fs'
import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

const packageRoot = new URL('../', import.meta.url)
const sourcePath = new URL('build/app-icon.png', packageRoot)

const iconset = new Map([
  ['icon_16x16.png', 16],
  ['icon_16x16@2x.png', 32],
  ['icon_32x32.png', 32],
  ['icon_32x32@2x.png', 64],
  ['icon_128x128.png', 128],
  ['icon_128x128@2x.png', 256],
  ['icon_256x256.png', 256],
  ['icon_256x256@2x.png', 512],
  ['icon_512x512.png', 512],
  ['icon_512x512@2x.png', 1024],
])

describe('application icon source', () => {
  it('keeps profile sync from overwriting the canonical Desktop icon', () => {
    const profileSync = readFileSync(
      new URL('scripts/sync-emate-profile.mjs', packageRoot),
      'utf8',
    )
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))
    const buildSdk = manifest.scripts['build:sdk'] as string

    expect(profileSync).not.toContain(".toFile(join(desktopRoot, 'build', 'app-icon.png'))")
    expect(buildSdk.indexOf('sync-emate-profile.mjs')).toBeLessThan(
      buildSdk.indexOf('generate-mac-app-icon.mjs'),
    )
  })

  it('keeps one transparent, color-managed C03 production source', async () => {
    const source = readFileSync(sourcePath)
    const metadata = await sharp(source).metadata()
    const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({
      resolveWithObject: true,
    })

    expect(metadata).toEqual(expect.objectContaining({
      format: 'png',
      width: 1024,
      height: 1024,
      space: 'rgb16',
      depth: 'ushort',
      bitsPerSample: 16,
      channels: 4,
      hasAlpha: true,
    }))
    expect(metadata.icc?.byteLength).toBeGreaterThan(0)

    let partialAlpha = 0
    let charcoal = 0
    let orange = 0
    let cream = 0
    for (let y = 0; y < info.height; y += 1) {
      for (let x = 0; x < info.width; x += 1) {
        const offset = (y * info.width + x) * info.channels
        const red = data[offset]!
        const green = data[offset + 1]!
        const blue = data[offset + 2]!
        const alpha = data[offset + 3]!
        if ((x < 32 || y < 32 || x >= info.width - 32 || y >= info.height - 32) && alpha !== 0) {
          throw new Error(`non-transparent app-icon border at ${x},${y}: ${alpha}`)
        }
        if (alpha > 0 && alpha < 255) partialAlpha += 1
        if (alpha < 250) continue

        const maximum = Math.max(red, green, blue)
        const minimum = Math.min(red, green, blue)
        if (maximum <= 165 && maximum - minimum <= 75) charcoal += 1
        else if (red >= 90 && red - green >= 20 && green - blue >= 3 && blue <= 105) orange += 1
        else if (red >= 160 && green >= 135 && blue >= 90 && red - blue <= 145) cream += 1
        else throw new Error(`unexpected opaque app-icon color: ${red},${green},${blue}`)
      }
    }

    expect(partialAlpha).toBeGreaterThan(1_000)
    expect(charcoal).toBeGreaterThan(500_000)
    expect(orange).toBeGreaterThan(100_000)
    expect(cream).toBeGreaterThan(10_000)
  })

  it('keeps non-empty macOS iconset and native ICNS assets', async () => {
    const filenames = readdirSync(new URL('build/icon.iconset/', packageRoot)).sort()
    expect(filenames).toEqual([...iconset.keys()].sort())

    for (const [filename, size] of iconset) {
      const icon = sharp(readFileSync(new URL(`build/icon.iconset/${filename}`, packageRoot)))
      const metadata = await icon.metadata()
      const { info } = await icon
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
        .toBuffer({ resolveWithObject: true })
      expect(metadata).toEqual(expect.objectContaining({
        format: 'png',
        width: size,
        height: size,
        channels: 4,
        hasAlpha: true,
      }))
      expect(metadata.icc?.byteLength).toBeGreaterThan(0)
      expect(info.width).toBeGreaterThan(size / 2)
      expect(info.height).toBeGreaterThan(size / 2)
    }

    const icns = readFileSync(new URL('build/icon.icns', packageRoot))
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns')
    expect(icns.byteLength).toBeGreaterThan(1_000)
  })

  it('keeps PNG-backed 32/64/128/256 Windows ICO entries', () => {
    const ico = readFileSync(new URL('build/icon.ico', packageRoot))
    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(4)

    const sizes = []
    for (let index = 0; index < 4; index += 1) {
      const entry = 6 + index * 16
      sizes.push(ico[entry] || 256)
      expect(ico[entry + 1] || 256).toBe(sizes[index])
      expect(ico.readUInt16LE(entry + 4)).toBe(1)
      expect(ico.readUInt16LE(entry + 6)).toBe(32)
      const length = ico.readUInt32LE(entry + 8)
      const offset = ico.readUInt32LE(entry + 12)
      expect(ico.subarray(offset, offset + 8)).toEqual(Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]))
      expect(length).toBeGreaterThan(100)
    }
    expect(sizes).toEqual([32, 64, 128, 256])
  })

  it('keeps Electron packaging on the two generated PNG consumers', () => {
    const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))

    expect(manifest.build.mac.icon).toBe('build/app-icon-mac.png')
    expect(manifest.build.win.icon).toBe('build/app-icon.png')
  })
})
