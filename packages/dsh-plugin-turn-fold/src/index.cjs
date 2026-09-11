'use strict'

/**
 * e-Mate host entry for the turn-fold provider.
 *
 * Upstream's entry injects `harmony`, the third-party runtime patcher that applied the Source
 * Patches in the browser. DSH 0.1.5 ships no Harmony layer and the vendored harmony runtime cannot
 * be imported on it, so that injection could never be satisfied: the row stayed PENDING forever
 * and the provider never applied. This entry owns the host half instead. It keeps the settings
 * registration upstream performed and adds the seats that hand the patched bundle to the browser
 * without writing it anywhere.
 *
 * Two routes, both narrower than the registry's own `/plugins` prefix, and neither equal to it -
 * the Web server refuses only an identical (kind, path) pair and dispatches longest-prefix-wins
 * (webserver/src/index.ts:160-172, :317-326), so these are additional owners inside the registry's
 * subtree rather than a second owner of its route:
 *
 * - `/plugins/` is the combo pathname. `comboUrl()` builds `/plugins/??<id>/client.js,…&rev=…`,
 *   whose pathname is exactly `/plugins/`, and the boot graph addresses every client bundle
 *   through it. The prefix rule compares `pathname === prefix` or `pathname.startsWith(prefix +
 *   '/')`, so this route matches the combo pathname and nothing else.
 * - `/plugins/<pkg>` serves the same package's per-entry bundle (`/plugins/<pkg>/client.js`).
 *
 * The patch itself comes from `transform.cjs`, which verifies the served bytes against the shared
 * pin before rewriting them and never touches the filesystem. The bytes verified are the ones the
 * registry serves - `clientModules.clientPath()` names that exact file - because the installed
 * product has no Harness checkout to walk and the assembled closure is what reaches the browser.
 */

const { Config, SETTINGS_NAMESPACE, createSettingsSchema } = require('./settings.cjs')
const { TARGET, transformClientBundle } = require('./transform.cjs')

const ROUTE_COMBO = '/plugins/'
const ROUTE_PACKAGE = '/plugins/' + TARGET.package
/**
 * The name the registry serves the bundle under, which is not the file name on disk: the artifact
 * lives at `<pkg>/lib/client.js` (TARGET.file) but every served address uses `<id>/client.js`
 * (client-modules comboUrl :239-242 and comboSource's fallbackSource :292-294).
 */
const SERVED_NAME = 'client.js'
const BUNDLE_PATH = ROUTE_PACKAGE + '/' + SERVED_NAME
const COMBO_RESOURCE = TARGET.package + '/' + SERVED_NAME

/** Debugger trailers the combo route strips before embedding a bundle (client-modules :172-174, :288-292). */
const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/

/** Pathname of one request URL, without its query. */
function pathOf(url) {
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}

/** Response headers as the plain object `writeHead` takes. */
function headersOf(response) {
  return Object.fromEntries(response.headers.entries())
}

/**
 * The executable segment the combo route embeds for one bundle.
 * Mirrors `comboSource`: strip the debugger trailers, then ensure one trailing newline.
 * @param {string} text - the bundle as it sits on disk.
 * @returns {string} the segment the combo route concatenates.
 */
function comboSegment(text) {
  let source = text.replace(SOURCE_URL_TRAILER, '').replace(SOURCE_MAP_TRAILER, '')
  if (!source.endsWith('\n')) source += '\n'
  return source
}

/**
 * Whether one combo request lists this package's bundle.
 *
 * Parsed as a URL rather than by slicing at the first '?': the combo form is `/plugins/??<list>`,
 * so the resource list lives after the second '?', and `search` keeps the delimiter that makes the
 * `??` prefix check meaningful.
 */
function comboListsTarget(url) {
  const search = new URL(url, 'http://dsh.invalid').search
  if (!search.startsWith('??')) return false
  const resources = search.slice(2).split('&', 1)[0]
  return resources.split(',').includes(COMBO_RESOURCE)
}

/**
 * Replace this package's segment inside an already-composed combo body.
 * @param {string} body - the registry's combo response text.
 * @param {string} before - the segment the registry embedded for the served bundle.
 * @param {string} after - the segment to embed instead.
 * @returns {string|undefined} the rewritten body, or undefined when the seam is not exactly one.
 */
function replaceComboSegment(body, before, after) {
  const occurrences = body.split(before).length - 1
  if (occurrences !== 1) return undefined
  // A function replacer, never a replacement string: the patched bundle legitimately contains the
  // sequence `$\`` (offset 425554 of the pinned client), and `String.prototype.replace` would read
  // it as the "portion before the match" pattern and silently delete those two characters, producing
  // a bundle that no longer parses. Verified by the boot smoke, which executes the served bytes.
  return body.replace(before, () => after)
}

/**
 * Answer one request under this package's bundle subtree.
 *
 * Every resource is resolved through the registry itself, so unknown URLs keep the registry's own
 * 404 and the advertised revision and cache headers are the ones the shell already published. Only
 * this package's bytes are replaced, and only when the seam resolves exactly once.
 */
async function serve(ctx, req, res, state) {
  const url = req.url ?? '/'
  const method = req.method ?? 'GET'
  const pathname = pathOf(url)
  const original = ctx.clientModules.fetchBundle(new Request('http://dsh.invalid' + url, { method }))

  const send = (status, headers, body) => {
    res.writeHead(status, headers)
    res.end(method === 'HEAD' ? undefined : body)
  }

  if (original.status !== 200) {
    send(original.status, headersOf(original), Buffer.from(await original.arrayBuffer()))
    return
  }

  const originalBytes = Buffer.from(await original.arrayBuffer())
  let body = originalBytes
  if (pathname === ROUTE_COMBO && comboListsTarget(url)) {
    const rewritten = replaceComboSegment(
      originalBytes.toString('utf8'),
      comboSegment(state.diskText),
      comboSegment(state.patchedText),
    )
    // Refuse rather than guess: a combo whose seam is not exactly one is served untouched.
    if (rewritten !== undefined) body = Buffer.from(rewritten, 'utf8')
  } else if (pathname === BUNDLE_PATH) {
    body = Buffer.from(state.patchedText, 'utf8')
  }

  if (body === originalBytes) {
    send(original.status, headersOf(original), originalBytes)
    return
  }
  send(200, { ...headersOf(original), 'content-length': String(body.byteLength) }, body)
}

exports.Config = Config
exports.inject = ['webServer', 'clientModules']
exports.name = 'emate-turn-fold'

/**
 * Register the settings scope and, when the pinned bundle verifies, the patched-bundle routes.
 * @param {*} ctx - the Host context carrying `webServer` and `clientModules`.
 * @param {*} config - the settings base handed to the registered scope.
 * @returns {void}
 */
exports.apply = (ctx, config) => {
  ctx.inject(['settings'], (settingsCtx) => {
    settingsCtx.settings.register(SETTINGS_NAMESPACE, createSettingsSchema(), { base: config })
  })

  const bundlePath = ctx.clientModules?.clientPath?.(TARGET.package)
  if (typeof bundlePath !== 'string' || bundlePath.length === 0) {
    // No served bundle means no patch target. The row still owns its settings scope; it simply
    // has nothing to fold.
    ctx.logger?.warn?.('turn-fold found no served bundle for ' + TARGET.package)
    return
  }

  let patched
  let diskText
  try {
    const { readFileSync } = require('node:fs')
    diskText = readFileSync(bundlePath, 'utf8')
    patched = transformClientBundle({ sourcePath: bundlePath })
  } catch (cause) {
    // Fail closed, exactly as the exemption requires: a bundle whose identity or compiled shape was
    // not verified is served untouched, so the capability is absent rather than wrong.
    ctx.logger?.warn?.('turn-fold refused to patch the pinned ui-chat bundle', cause)
    return
  }

  const state = { diskText, patchedText: patched.text }
  const handler = (req, res) => { void serve(ctx, req, res, state) }
  ctx.effect(
    () => [
      ctx.webServer.register({ kind: 'prefix', path: ROUTE_COMBO, handler }),
      ctx.webServer.register({ kind: 'prefix', path: ROUTE_PACKAGE, handler }),
    ],
    'emate-turn-fold: patched ui-chat bundle',
  )
}
