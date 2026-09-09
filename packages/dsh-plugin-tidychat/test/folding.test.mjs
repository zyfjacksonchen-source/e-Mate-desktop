import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { JSDOM } from 'jsdom'

const source = readFileSync(new URL('../src/client/index.ts', import.meta.url), 'utf8')
const code = stripTypeScriptTypes(source.replace("import * as React from 'react'", 'const React = {}')
  .replace('export const inject', 'const inject').replace('export function apply', 'function apply'), { mode: 'transform' })

function harness(rows, stored = {}) {
  const dom = new JSDOM(`<main data-conversation-scroll><button id="older">加载更早</button>${rows}</main>`, { url: 'https://test.invalid' })
  const w = dom.window
  const subscriptions = []
  const disposers = []
  const intervals = []
  let value = { fold: true, navigator: true, autoLoad: true, ...stored }
  const scope = { getSnapshot: () => ({ status: 'ready', value, writable: true }), subscribe: fn => { subscriptions.push(fn); return () => {} } }
  const ctx = {
    get: key => key === 'webUiSettings' ? { bind: () => scope } : undefined,
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    slots: { inject: (_slot, fn) => fn(), register: () => () => {} },
  }
  runInNewContext(`${code}\napply(ctx)`, {
    ctx, window: w, document: w.document, location: w.location, localStorage: w.localStorage,
    navigator: w.navigator, Element: w.Element, HTMLElement: w.HTMLElement, Node: w.Node,
    NodeFilter: w.NodeFilter, MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w), performance, console,
    setInterval: fn => { intervals.push(fn); return intervals.length }, clearInterval: () => {},
    setTimeout, clearTimeout,
  })
  return {
    document: w.document,
    update: next => { value = { ...value, ...next }; subscriptions.forEach(fn => fn()) },
    tick: () => intervals.forEach(fn => fn()),
    close: () => { disposers.reverse().forEach(fn => fn()); dom.window.close() },
  }
}
const step = (id, body) => `<div id="${id}" data-chat-anchor-key="14:assistant-step1:0" data-chat-flow-kind="assistant-step">${body}</div>`
const tool = body => `<div id="tool" data-chat-anchor-key="9:tool-call1" data-chat-flow-kind="tool-call">${body}</div>`
const tail = '<div data-chat-anchor-key="9:turn-tail1" data-chat-flow-kind="turn-tail">用时 2s</div>'

test('fold preserves image-only answers, mixed thought/images and tool artifact terminals', () => {
  for (const rows of [step('image', '<img src="x.png">'), step('image', '<div data-variant="think">thinking</div><img src="x.png">'), step('process', '<div data-variant="think">thinking</div>') + tool('<div data-emate-artifact-terminal><img src="x.png"></div>')]) {
    const h = harness(rows + tail)
    try {
      const image = h.document.querySelector('img')
      assert.equal(image.closest('[data-tidychat-folded],[data-tidychat-folded-inline]'), null)
      assert.equal(h.document.querySelectorAll('img').length, 1)
    } finally { h.close() }
  }
})

test('late artifacts and disabling fold clear previous hidden state without duplicating images', () => {
  const h = harness(step('image', '<div data-variant="think">thinking</div>') + tail)
  try {
    const row = h.document.getElementById('image')
    assert.equal(row.hasAttribute('data-tidychat-folded'), true)
    row.insertAdjacentHTML('beforeend', '<img src="late.png">')
    h.update({})
    assert.equal(row.hasAttribute('data-tidychat-folded'), false)
    h.update({ fold: false })
    assert.equal(h.document.querySelector('[data-tidychat-folded-inline]'), null)
    assert.equal(h.document.querySelectorAll('img').length, 1)
  } finally { h.close() }
})

test('saved autoLoad true cannot trigger loading; the original manual button still works', () => {
  assert.doesNotMatch(source, /autoLoad|scheduleNext|requestIdleCallback|\.click\(/)
  const h = harness(step('answer', 'Answer') + tail)
  try {
    let loads = 0
    h.document.getElementById('older').addEventListener('click', () => { loads += 1 })
    h.tick()
    h.update({ autoLoad: true })
    h.tick()
    assert.equal(loads, 0)
    h.document.getElementById('older').click()
    assert.equal(loads, 1)
  } finally { h.close() }
})
