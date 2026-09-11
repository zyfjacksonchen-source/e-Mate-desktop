import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import ToolRuntime, { validateJsonSchemaValue } from '../../../upstream/deepseek-harness/packages/core/tools/lib/index.js'
import SystemPrompt from '../../../upstream/deepseek-harness/packages/core/system-prompt/lib/index.js'
const nativeRequire = createRequire(new URL('../../../upstream/deepseek-harness/packages/core/tools/package.json', import.meta.url))
const { Context } = nativeRequire('@deepseek-ai/cordis')
import { fileURLToPath } from 'node:url'
import {
  formatAccessibilitySnapshot,
  validateCdpEndpoint,
} from '../lib/cdp.mjs'
import {
  apply,
  authorizeBrowserMutation,
  browserToolRequiresApproval,
  CDP_CONTROL_SETTINGS_NAMESPACE,
  launchManagedChrome,
} from '../lib/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

function settingsHarness(initial = true, endpoint = 'http://127.0.0.1:9222') {
  let value = { allowControl: initial, endpoint }
  let revision = 0
  return {
    settings: {
      writable: true,
      register: () => ({ get: () => value }),
      describe: () => [{ ns: CDP_CONTROL_SETTINGS_NAMESPACE, revision }],
      replace: async (_ns, next, expectedRevision) => {
        assert.equal(expectedRevision, revision)
        value = next
        revision += 1
      },
    },
    get: () => value,
  }
}

test('accepts only an explicit literal loopback CDP origin', () => {
  assert.equal(validateCdpEndpoint('http://127.0.0.1:9222'), 'http://127.0.0.1:9222')
  assert.equal(validateCdpEndpoint('http://[::1]:9222'), 'http://[::1]:9222')
  for (const endpoint of [
    'https://127.0.0.1:9222',
    'http://localhost:9222',
    'http://example.com:9222',
    'http://127.0.0.1:9222/json',
    'http://user@127.0.0.1:9222',
  ]) assert.throws(() => validateCdpEndpoint(endpoint), /loopback HTTP origin/)
})

test('renders bounded session indices without exposing form values', () => {
  const snapshot = formatAccessibilitySnapshot(
    { title: 'Example', url: 'https://example.com/' },
    [
      { role: { value: 'heading' }, name: { value: 'Welcome' } },
      { role: { value: 'button' }, name: { value: 'Continue' }, backendDOMNodeId: 41 },
      { role: { value: 'textbox' }, name: { value: 'Password' }, value: { value: 'never-print-this' }, backendDOMNodeId: 42 },
    ],
  )
  assert.match(snapshot.text, /\[1\] button "Continue"/)
  assert.match(snapshot.text, /\[2\] textbox "Password"/)
  assert.doesNotMatch(snapshot.text, /never-print-this/)
  assert.deepEqual([...snapshot.indices], [[1, 41], [2, 42]])
})

test('ships no extension, browser binary, runtime downloader, or MCP subprocess', async () => {
  const manifest = JSON.parse(await readFile(`${root}/package.json`, 'utf8'))
  const source = await readFile(`${root}/src/index.ts`, 'utf8')
  assert.equal(manifest.name, '@e-mate/dsh-plugin-cdp')
  assert.equal(manifest.eMate.harnessCommit, '43c411a51c555e61e9b5f500442cb3404a2d70cd')
  assert.equal(manifest.files.includes('extension'), false)
  assert.doesNotMatch(source, /npx|playwright|puppeteer|chrome-devtools-mcp|child_process/iu)
  assert.match(source, /persistent isolated profile and loopback-only CDP endpoint/u)
})

test('projects real CDP readiness and routes page mutations through native approval', async () => {
  assert.equal(browserToolRequiresApproval('browser_scroll'), true)
  assert.equal(browserToolRequiresApproval('browser_tabs'), false)

  const capabilities = []
  const harness = settingsHarness()
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'page-1',
    type: 'page',
    title: 'Example',
    url: 'https://example.com/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1',
  }]), { status: 200 })
  try {
    apply({
      approval: {},
      settings: harness.settings,
      tools: { register: () => () => undefined },
      systemPrompt: { section: () => () => undefined },
      userQuestions: { ask: async () => { throw new Error('unexpected question') } },
      emateCapabilities: {
        register: definition => { capabilities.push(definition); return () => undefined },
      },
      effect: callback => callback(),
    })
    assert.equal(capabilities.length, 1)
    assert.deepEqual(capabilities[0].actions, [
      { id: 'open-browser', label: '打开浏览器', kind: 'primary' },
      { id: 'enable-control', label: '启用浏览器控制', kind: 'primary' },
      { id: 'disable-control', label: '停用浏览器控制', kind: 'secondary' },
    ])
    assert.deepEqual(await capabilities[0].status(new AbortController().signal), {
      state: 'ready',
      detail: 'CDP 已连接 · 1 个页面 · 控制已启用',
      action_ids: ['disable-control'],
    })
    await capabilities[0].invoke('disable-control')
    assert.equal(harness.get().allowControl, false)
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('starts installed Chrome with an isolated persistent profile and fixed loopback port', async () => {
  const spawns = []
  const controller = new AbortController()
  const profile = await mkdtemp(join(tmpdir(), 'e-mate-cdp-test-'))
  try {
    await launchManagedChrome({
      subprocess: {
        resolveExecutable: async command => `/resolved/${command}`,
        spawn: spec => {
          spawns.push(spec)
          return { done: Promise.resolve({ exitCode: 0 }) }
        },
      },
    }, 'http://127.0.0.1:9222', profile, controller.signal)
    const chromeArgs = [
      '--remote-debugging-port=9222',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ]
    assert.deepEqual(spawns[0].argv, process.platform === 'darwin'
      ? ['/resolved/open', '-na', 'Google Chrome', '--args', ...chromeArgs]
      : process.platform === 'win32'
        ? ['/resolved/cmd.exe', '/d', '/s', '/c', 'start', '', 'chrome.exe', ...chromeArgs]
        : ['/resolved/google-chrome', ...chromeArgs])
  } finally {
    await rm(profile, { recursive: true, force: true })
  }
})

test('keeps Chrome out of application startup and starts it on first browser use', async () => {
  const tools = []
  const capabilities = []
  const disposers = []
  const harness = settingsHarness()
  let browserRunning = false
  let launches = 0
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => {
    if (!browserRunning) throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
    return new Response(JSON.stringify([{
      id: 'page-1',
      type: 'page',
      title: 'Example',
      url: 'https://example.com/',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/page-1',
    }]), { status: 200 })
  }
  try {
    apply({
      approval: {},
      settings: harness.settings,
      subprocess: {
        resolveExecutable: async command => `/resolved/${command}`,
        spawn: () => {
          launches += 1
          browserRunning = true
          return { done: Promise.resolve({ exitCode: 0 }) }
        },
      },
      tools: { register: definition => { tools.push(definition); return () => undefined } },
      systemPrompt: { section: () => () => undefined },
      userQuestions: { ask: async () => { throw new Error('unexpected question') } },
      emateCapabilities: {
        register: definition => { capabilities.push(definition); return () => undefined },
      },
      effect: callback => {
        const dispose = callback()
        if (typeof dispose === 'function') disposers.push(dispose)
      },
    })

    assert.equal(launches, 0)
    assert.deepEqual(await capabilities[0].status(new AbortController().signal), {
      state: 'ready',
      detail: '首次网页任务时自动启动 Chrome · 控制已启用',
      action_ids: ['open-browser', 'disable-control'],
    })
    assert.equal(launches, 0)

    const tabs = tools.find(tool => tool.name === 'browser_tabs')
    assert.match((await tabs.execute({}, {
      agent: { id: 'agent-1', session: {} },
      callId: 'call-1',
      signal: new AbortController().signal,
    })).text, /page-1\tExample\thttps:\/\/example\.com\//u)
    assert.equal(launches, 1)
  } finally {
    for (const dispose of disposers.reverse()) dispose()
    globalThis.fetch = previousFetch
  }
})

test('rejects mutations before CDP when native approval policy is never', async () => {
  const tools = []
  let requests = 0
  const harness = settingsHarness(false)
  apply({
    approval: {
      config: { policy: 'ask' },
      overrideOf: () => 'never',
      request: async () => { requests += 1; return 'allowed-once' },
    },
    settings: harness.settings,
    tools: { register: definition => { tools.push(definition); return () => undefined } },
    systemPrompt: { section: () => () => undefined },
    userQuestions: { ask: async () => { throw new Error('unexpected question') } },
    emateCapabilities: { register: () => () => undefined },
    effect: callback => callback(),
  })
  const scroll = tools.find(tool => tool.name === 'browser_scroll')
  await assert.rejects(
    scroll.execute({ direction: 'down' }, {
      agent: { id: 'agent-1', session: {} },
      callId: 'call-1',
      signal: new AbortController().signal,
    }),
    /approval prompts are disabled/,
  )
  assert.equal(requests, 0)
})

test('keeps the CDP control grant separate from sandbox and native approval', async () => {
  let requests = 0
  const exec = {
    agent: { id: 'agent-1', session: {} },
    callId: 'call-1',
    signal: new AbortController().signal,
  }
  const ctx = {
    approval: {
      config: { policy: 'never' },
      overrideOf: () => 'never',
      request: async () => { requests += 1; return 'allowed-once' },
    },
  }
  await authorizeBrowserMutation(ctx, exec, 'browser_click', true)
  assert.equal(requests, 0)
  await assert.rejects(authorizeBrowserMutation(ctx, exec, 'browser_click', false), /approval prompts are disabled/)
  assert.equal(requests, 0)
})

test('does not reuse a browser-control grant for a different CDP endpoint', async () => {
  const capabilities = []
  const harness = settingsHarness(true)
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'page-1',
    type: 'page',
    title: 'Example',
    url: 'https://example.com/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9333/devtools/page/page-1',
  }]), { status: 200 })
  try {
    apply({
      approval: {},
      settings: harness.settings,
      tools: { register: () => () => undefined },
      systemPrompt: { section: () => () => undefined },
      userQuestions: { ask: async () => { throw new Error('unexpected question') } },
      emateCapabilities: {
        register: definition => { capabilities.push(definition); return () => undefined },
      },
      effect: callback => callback(),
    }, { endpoint: 'http://127.0.0.1:9333' })
    assert.deepEqual(await capabilities[0].status(new AbortController().signal), {
      state: 'ready',
      detail: 'CDP 已连接 · 1 个页面 · 控制未启用',
      action_ids: ['enable-control'],
    })
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('lets an owning Agent change the same persisted control grant through UserQuestions', async () => {
  const tools = []
  const harness = settingsHarness(false)
  apply({
    approval: { config: { policy: 'never' }, overrideOf: () => 'never' },
    settings: harness.settings,
    tools: { register: definition => { tools.push(definition); return () => undefined } },
    systemPrompt: { section: () => () => undefined },
    userQuestions: { ask: async () => ({ answers: [{ selected: ['启用控制'] }] }) },
    emateCapabilities: { register: () => () => undefined },
    effect: callback => callback(),
  })
  const access = tools.find(tool => tool.name === 'browser_control_access')
  await assert.doesNotReject(access.execute({ enabled: true }, {
    agent: { id: 'agent-1', session: {} },
    callId: 'call-1',
    signal: new AbortController().signal,
  }))
  assert.equal(harness.get().allowControl, true)
})

test('makes CDP the only browser path and no longer names the retired Computer Use capability', async () => {
  const prompts = []
  const harness = settingsHarness()
  apply({
    approval: {},
    settings: harness.settings,
    tools: { register: () => () => undefined },
    systemPrompt: { section: definition => { prompts.push(definition); return () => undefined } },
    userQuestions: { ask: async () => { throw new Error('unexpected question') } },
    emateCapabilities: { register: () => () => undefined },
    effect: callback => callback(),
  })
  assert.equal(harness.get().allowControl, true)
  assert.match(prompts[0].text, /only when the latest user request explicitly asks to read or operate a visible Chrome webpage/u)
  assert.match(prompts[0].text, /Never use them for attachments, image generation, native apps, or non-page work/u)
  // The capability was removed in 2.0.18; the browser guidance must not keep
  // promising a Computer Use path the Profile no longer ships.
  assert.doesNotMatch(prompts[0].text, /Computer Use|电脑操控/u)
})


test('native registry exposes all CDP argument fields as closed JSON Schema and dispatches valid arguments', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const harness = settingsHarness(false)
  const disposers = []
  const previousFetch = globalThis.fetch
  const previousWebSocket = globalThis.WebSocket
  const commands = []
  globalThis.fetch = async () => new Response(JSON.stringify([{
    id: 'schema-page', type: 'page', title: 'Acceptance', url: 'https://example.com/',
    webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/schema-page',
  }]))
  globalThis.WebSocket = class extends EventTarget {
    static OPEN = 1
    readyState = 1
    constructor() { super(); queueMicrotask(() => this.dispatchEvent(new Event('open'))) }
    send(payload) {
      const command = JSON.parse(payload); commands.push(command)
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', {
        data: JSON.stringify({ id: command.id, result: {} }),
      })))
    }
    close() { this.dispatchEvent(new Event('close')) }
  }
  try {
    apply({
      tools: ctx.tools,
      subprocess: {
        resolveExecutable: async command => `/fixture/${command}`,
        spawn: () => ({ done: Promise.resolve({ exitCode: 0 }) }),
      },
      approval: { config: { policy: 'never' }, overrideOf: () => 'never' },
      settings: harness.settings,
      systemPrompt: { section: () => () => undefined },
      userQuestions: { ask: async () => ({ answers: [{ selected: ['启用控制'] }] }) },
      emateCapabilities: { register: () => () => undefined },
      effect: callback => { const dispose = callback(); if (dispose) disposers.push(dispose) },
    })
    const cases = {
      browser_control_access: [{ enabled: true }, ['enabled']],
      browser_tabs: [{}, []],
      browser_select_tab: [{ target_id: 'page-1' }, ['target_id']],
      browser_snapshot: [{}, []],
      browser_click: [{ index: 1 }, ['index']],
      browser_type: [{ index: 1, text: 'acceptance', replace: true }, ['index', 'text']],
      browser_press: [{ key: 'Enter' }, ['key']],
      browser_navigate: [{ url: 'https://example.com/' }, ['url']],
      browser_back: [{}, []], browser_forward: [{}, []], browser_reload: [{}, []],
      browser_scroll: [{ direction: 'down', amount: 10 }, ['direction']],
      browser_get_text: [{ selector: 'main' }, []],
      browser_wait: [{ ms: 0 }, []],
    }
    const schemas = ctx.tools.schemas().filter(tool => tool.name.startsWith('browser_'))
    assert.equal(schemas.length, 14)
    for (const tool of schemas) {
      const [args, required] = cases[tool.name]
      const schema = tool.parameters
      assert.equal(schema.type, 'object', tool.name)
      assert.equal(schema.additionalProperties, false, tool.name)
      assert.deepEqual(Object.keys(schema.properties).sort(), Object.keys(args).sort(), tool.name)
      assert.deepEqual(schema.required ?? [], required, tool.name)
      assert.deepEqual(validateJsonSchemaValue(schema, args, ''), [], tool.name)
      assert.notEqual(validateJsonSchemaValue(schema, { ...args, unexpected: true }, '').length, 0, tool.name)
      for (const key of required) {
        const missing = { ...args }; delete missing[key]
        assert.notEqual(validateJsonSchemaValue(schema, missing, '').length, 0, `${tool.name}.${key}`)
      }
    }
    const press = schemas.find(tool => tool.name === 'browser_press').parameters
    assert.notEqual(validateJsonSchemaValue(press, { key: 'unlisted-key' }, '').length, 0)
    const scroll = schemas.find(tool => tool.name === 'browser_scroll').parameters
    assert.notEqual(validateJsonSchemaValue(scroll, { direction: 'sideways' }, '').length, 0)
    // Reproduce the old wire contract: its closed root rejects the URL and
    // accepts {}, exactly the model-visible failure reported by the installed app.
    const old = { type: 'object', additionalProperties: false, url: { type: 'string', required: true } }
    assert.deepEqual(validateJsonSchemaValue(old, {}, ''), [])
    assert.notEqual(validateJsonSchemaValue(old, { url: 'https://example.com/' }, '').length, 0)
    // Dispatch through the native registry, not a direct execute fixture.
    const result = await ctx.tools.execute({
      name: 'browser_control_access', arguments: { enabled: true }, callId: 'cdp-schema-control',
      agent: { id: 'cdp-schema-agent', session: {} }, signal: new AbortController().signal,
    })
    assert.equal(harness.get().allowControl, true)
    assert.match(JSON.stringify(result), /Browser control is now enabled/)
    const navigate = await ctx.tools.execute({
      name: 'browser_navigate', arguments: cases.browser_navigate[0], callId: 'cdp-schema-navigate',
      agent: { id: 'cdp-schema-agent', session: {} }, signal: new AbortController().signal,
    })
    assert.match(JSON.stringify(navigate), /Navigated Chrome to https:\/\/example.com\//)
    assert.deepEqual(commands.map(({ method, params }) => ({ method, params })), [
      { method: 'Page.navigate', params: { url: 'https://example.com/' } },
    ])
    const invalid = await ctx.tools.execute({
      name: 'browser_navigate', arguments: { url: 'https://user:password@example.com/' }, callId: 'cdp-schema-reject',
      agent: { id: 'cdp-schema-agent', session: {} }, signal: new AbortController().signal,
    })
    assert.equal(commands.length, 1, 'credential-bearing URL must not reach CDP')
    assert.doesNotMatch(JSON.stringify(invalid), /Navigated Chrome to/)

  } finally {
    globalThis.fetch = previousFetch
    globalThis.WebSocket = previousWebSocket
    for (const dispose of disposers.reverse()) dispose()
    await ctx.fiber.dispose()
  }
})

function launchFixture(spawn) {
  let capability
  const disposers = []
  apply({
    approval: {}, settings: settingsHarness().settings,
    subprocess: { resolveExecutable: async () => '/fixture/chrome', spawn },
    tools: { register: () => () => {} }, systemPrompt: { section: () => () => {} },
    userQuestions: { ask: async () => { throw new Error('unexpected question') } },
    emateCapabilities: { register: value => { capability = value; return () => {} } },
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
  })
  return { capability, dispose: () => disposers.reverse().forEach(dispose => dispose()) }
}
const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })
const signal = () => new AbortController().signal

test('cold Chrome check-in beyond twelve seconds succeeds within the existing Tool budget', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now
  let elapsed = 0, launches = 0
  Date.now = () => elapsed
  globalThis.fetch = async () => {
    if (launches > 0) elapsed += 7_000
    if (elapsed < 14_000) throw refused()
    return new Response('[]')
  }
  const fixture = launchFixture(() => { launches++; return { done: Promise.resolve({ exitCode: 0 }) } })
  try {
    await fixture.capability.invoke('open-browser', {}, signal())
    assert.equal(launches, 1)
    assert.equal(elapsed, 14_000)
    await fixture.capability.invoke('open-browser', {}, signal())
    assert.equal(launches, 1, 'connected Chrome with zero pages is reused')
  } finally { fixture.dispose(); globalThis.fetch = originalFetch; Date.now = originalNow }
})

test('HTTP, JSON, debugger origin and timeout errors fail closed without launching', async () => {
  const originalFetch = globalThis.fetch
  let launches = 0
  let respond
  globalThis.fetch = async () => respond()
  const fixture = launchFixture(() => { launches++; throw new Error('must not spawn') })
  try {
    for (const response of [
      () => new Response('', { status: 503 }),
      () => new Response('not JSON'),
      () => new Response(JSON.stringify([{ id: 'bad', type: 'page', title: 'Bad', url: '', webSocketDebuggerUrl: 'ws://example.com/devtools/page/bad' }])),
      () => { throw new DOMException('timeout', 'TimeoutError') },
    ]) {
      respond = response
      const status = await fixture.capability.status(signal())
      assert.equal(status.state, 'failed')
      assert.equal(status.action_ids.includes('open-browser'), false)
      await assert.rejects(fixture.capability.invoke('open-browser', {}, signal()))
    }
    assert.equal(launches, 0)
  } finally { fixture.dispose(); globalThis.fetch = originalFetch }
})

test('launch failure stays visible and permits retry, then a real connection recovers readiness', async () => {
  const originalFetch = globalThis.fetch
  let connected = false
  globalThis.fetch = async () => { if (!connected) throw refused(); return new Response('[]') }
  const fixture = launchFixture(() => { throw new Error('private launch failure') })
  try {
    await assert.rejects(fixture.capability.invoke('open-browser', {}, signal()))
    const failed = await fixture.capability.status(signal())
    assert.equal(failed.state, 'failed')
    assert.equal(failed.action_ids.includes('open-browser'), true)
    assert.doesNotMatch(failed.detail, /private/)
    connected = true
    assert.equal((await fixture.capability.status(signal())).state, 'ready')
    connected = false
    assert.equal((await fixture.capability.status(signal())).state, 'ready', 'old failure cleared by observed connection')
  } finally { fixture.dispose(); globalThis.fetch = originalFetch }
})

test('cancelling one waiter preserves a shared launch; pre-cancel never spawns', async () => {
  const originalFetch = globalThis.fetch
  let running = false, launches = 0, finishLaunch
  globalThis.fetch = async () => { if (!running) throw refused(); return new Response('[]') }
  const fixture = launchFixture(() => {
    launches++
    return { done: new Promise(resolve => { finishLaunch = () => { running = true; resolve({ exitCode: 0 }) } }) }
  })
  try {
    const cancelled = new AbortController()
    cancelled.abort(new Error('already cancelled'))
    await assert.rejects(fixture.capability.invoke('open-browser', {}, cancelled.signal), /already cancelled/)
    assert.equal(launches, 0)
    const first = new AbortController()
    const rejected = assert.rejects(fixture.capability.invoke('open-browser', {}, first.signal), /cancel one/)
    const second = fixture.capability.invoke('open-browser', {}, signal())
    await new Promise(resolve => setImmediate(resolve))
    first.abort(new Error('cancel one'))
    await rejected
    finishLaunch()
    await second
    assert.equal(launches, 1)
  } finally { fixture.dispose(); globalThis.fetch = originalFetch }
})

test('Chrome launch remains bounded by the Tool budget and disposal cancels the owner', async () => {
  const originalFetch = globalThis.fetch, originalNow = Date.now
  let elapsed = 0
  Date.now = () => elapsed
  globalThis.fetch = async () => { throw refused() }
  let fixture = launchFixture(() => { elapsed = 45_000; return { done: Promise.resolve({ exitCode: 0 }) } })
  try {
    await assert.rejects(fixture.capability.invoke('open-browser', {}, signal()), /任务时限/)
    assert.equal((await fixture.capability.status(signal())).state, 'failed')
    fixture.dispose()
    fixture = launchFixture(() => ({ done: Promise.resolve({ exitCode: 0 }) }))
    const rejected = assert.rejects(fixture.capability.invoke('open-browser', {}, signal()), /disposed/)
    await new Promise(resolve => setImmediate(resolve))
    fixture.dispose()
    await rejected
  } finally { fixture.dispose(); globalThis.fetch = originalFetch; Date.now = originalNow }
})
