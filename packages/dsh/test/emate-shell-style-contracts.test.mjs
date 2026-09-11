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
