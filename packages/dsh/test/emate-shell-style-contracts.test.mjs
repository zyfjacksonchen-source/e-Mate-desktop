import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The expert-mode connector shows its state through a dot that is only legible when the
// checked rule paints the brand colour at full opacity. Losing either half hides the state
// the composer is reporting, which is the regression the ledger records.
const stylesheet = new URL(
  '../profile/plugins/emate-shell/src/client/composer-connectors.module.css',
  import.meta.url,
)
const css = readFileSync(fileURLToPath(stylesheet), 'utf8')
const checkedDot = /\.expert\[aria-checked='true'\]\s+i\s*\{[^}]*\}/u

test('the expert connector indicates its checked state', () => {
  const rule = checkedDot.exec(css)
  assert.notEqual(rule, null, 'the checked expert dot rule disappeared')
  assert.match(rule[0], /background:\s*var\(--emate-color-brand\)/u)
  assert.match(rule[0], /opacity:\s*1/u)
})

test('nothing hides the checked expert dot', () => {
  const hidden = [...css.matchAll(/\.expert\[aria-checked='true'\][^{]*\{[^}]*opacity:\s*0[^}]*\}/gu)]
  assert.deepEqual(hidden.map(match => match[0]), [])
})

// Ledger entry 820267ca3: the canvas action must stay legible over a light image, so its
// rule paints its own dark translucent surface instead of a theme background.
const batchProgress = readFileSync(fileURLToPath(new URL(
  '../profile/plugins/emate-shell/src/client/image-batch-progress.module.css',
  import.meta.url,
)), 'utf8')

test('the canvas action stays legible over a light image', () => {
  const rule = /\.canvasAction button\s*\{[^}]*\}/u.exec(batchProgress)
  assert.notEqual(rule, null, 'the canvas action rule disappeared')
  assert.match(rule[0], /color:\s*#fff/u, 'the action label is no longer forced white')
  assert.match(rule[0], /background:\s*rgb\(/u, 'the action background is theme dependent again')
  assert.match(rule[0], /box-shadow/u, 'the action lost the shadow that separates it from the image')
})

// Ledger entry c3ec64ae4: the gallery actions must stay in the flow and right aligned so
// the carousel controls below them remain reachable. The rule originally used margin-top;
// a later refactor expressed the same spacing as bottom padding, so the guard requires
// spacing by either means and never an absolute overlay.
const galleryStyles = readFileSync(fileURLToPath(new URL(
  '../profile/plugins/emate-shell/src/client/image-gallery.module.css',
  import.meta.url,
)), 'utf8')

test('the gallery actions do not overlay the carousel controls', () => {
  const rule = /\.galleryActions\s*\{[^}]*\}/u.exec(galleryStyles)
  assert.notEqual(rule, null, 'the gallery actions rule disappeared')
  assert.doesNotMatch(rule[0], /position:\s*absolute/u, 'the actions are an overlay again')
  assert.match(rule[0], /justify-content:\s*flex-end/u, 'the actions are no longer right aligned')
  const spaced = /margin-top/u.test(rule[0]) || /padding:\s*[^;]*\d/u.test(rule[0])
  assert.ok(spaced, 'the actions lost the spacing that clears the carousel controls')
})

// Ledger entries 680b68950 and 820267ca3 share this stylesheet: the batch action is hidden
// by default and must be reachable by pointer AND keyboard, so the reveal rule needs both a
// hover path and a focus path. A hover-only reveal locks keyboard users out of the action.
const batchStyles = readFileSync(fileURLToPath(new URL(
  '../profile/plugins/emate-shell/src/client/image-batch-progress.module.css',
  import.meta.url,
)), 'utf8')

test('the batch action reveals on hover and on focus', () => {
  const hidden = new RegExp(String.raw`\.canvasAction\s*\{[^}]*\}`, 'u').exec(batchStyles)
  assert.notEqual(hidden, null, 'the batch action rule disappeared')
  assert.match(hidden[0], /opacity:\s*0/u, 'the action is no longer hidden by default')
  assert.match(hidden[0], /pointer-events:\s*none/u, 'the hidden action still accepts pointer events')
  const reveal = /[^{}]*\.canvasAction[^{}]*\{[^}]*opacity:\s*1[^}]*\}/u.exec(batchStyles)
  assert.notEqual(reveal, null, 'no rule reveals the batch action')
  assert.match(reveal[0], /:hover/u, 'the action no longer reveals on hover')
  assert.match(reveal[0], /:focus/u, 'the action no longer reveals on keyboard focus')
  assert.match(reveal[0], /pointer-events:\s*auto/u, 'the revealed action stays unclickable')
})
