import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as Client from 'react-dom/client'
import * as JSX from 'react/jsx-runtime'
import { createClientModuleSystem, type ClientBundleRegistration, type ClientModuleLoaderTarget } from '../../../upstream/deepseek-harness/packages/client/modules/src/client/index.ts'
import { insertAsset } from '../src/client/model.ts'
import { ASSET_PATH, EDITOR_MODULE, emptyPage, emptyProject } from '../src/contract.ts'
// 0.1.5 boot: the HTML facade owns a registration queue, and its create() materializes the modules
// bundle and hands that queue to the module system, which switches it to live registration
// (upstream modules/src/index.ts bootInjections -> client/index.ts createClientModuleSystem).
// The editor graph row's bundle stays unloaded until the first import.
const pendingQueue: ClientBundleRegistration[] = []
const target: ClientModuleLoaderTarget = {
  mode: 'queue',
  pendingQueue,
  load(registration) { pendingQueue.push(registration) },
  create(options) { return createClientModuleSystem(target, { id: '@deepseek-ai/dsh-client-modules', exports: {} }, options) },
}
;(window as any).__ModuleLoader__ = target
const modules = target.create({
  boot: {
    rev: 'fixture',
    entries: [{ id: EDITOR_MODULE, url: ASSET_PATH + 'editor.js', rev: 'fixture' }],
    batches: [{ phase: 'application', url: ASSET_PATH + 'editor.js', rev: 'fixture', entries: [EDITOR_MODULE] }],
  },
  staticModules: { react: React, 'react-dom': ReactDOM, 'react-dom/client': Client, 'react/jsx-runtime': JSX },
})
const reference = document.createElement('canvas'); reference.width = new URLSearchParams(location.search).has('narrow') ? 40 : 400; reference.height = 300
const drawing = reference.getContext('2d')!
drawing.fillStyle = new URLSearchParams(location.search).has('dark') ? '#151515' : '#fff8ec'; drawing.fillRect(0, 0, 400, 300)
drawing.fillStyle = '#0080ff'; drawing.beginPath(); drawing.arc(100, 190, 70, 0, Math.PI * 2); drawing.fill()
drawing.fillStyle = '#ff8000'; drawing.beginPath(); drawing.moveTo(290, 110); drawing.lineTo(370, 260); drawing.lineTo(210, 260); drawing.fill()
const encoded = reference.toDataURL('image/png').split(',')[1]!
const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
const asset = { ownerSessionId: 'parent', ref: { attachmentId: `sha256:${hash}`, mediaType: 'image/png', bytes: bytes.length, width: reference.width, height: reference.height } }
const staged = new Map<string, any>([[asset.ref.attachmentId, { bytes_base64: encoded, ref: asset.ref }]])
let project = insertAsset(emptyProject('main'), 'page-1', asset)
;(window as any).canvasSubmissions = []
project.pages.push({ ...emptyPage('legacy', '旧项目页'), html: '<script>window.canvasAttacked=true</script><h1>Legacy HTML</h1>', slide: true })
let revision = 'a'.repeat(64)
const bridge = { sessionId: 'parent', close() {}, subscribe() { return () => {} }, beforeLeave() { return () => {} }, async submit(document: any, intent: any, instruction: string) { (window as any).canvasSubmissions.push({ intent, instruction }) }, async stageImages(files: File[]) {
    return await Promise.all(files.map(async file => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
      const ref = { attachmentId: `sha256:${hash}`, mediaType: file.type, bytes: bytes.length, width: 400, height: 300 }
      staged.set(ref.attachmentId, { ref, bytes_base64: btoa(Array.from(bytes, b => String.fromCharCode(b)).join('')) })
      return { ownerSessionId: 'parent', ref }
    }))
  },
  async call(endpoint: string, payload: any = {}) {
    if (endpoint === 'image') return staged.get(payload.attachment_id)
    if (endpoint === 'list') return [{ id: 'main', title: project.title }]
    if (endpoint === 'load') return { project, revision, recovered: false }
    if (endpoint === 'outputs') return { kind: 'images', assets: [] }
    if (endpoint === 'save') { if (payload.expected_revision !== revision) throw new Error('conflict'); project = payload.project; revision = (revision[0] === 'a' ? 'b' : 'a').repeat(64); return { project, revision, recovered: false } }
    throw new Error('unexpected fixture operation')
  },
}
;(window as any).readCanvasFixture = () => project
const button = document.getElementById('open')!
button.addEventListener('click', async () => {
  const editor = await modules.import(EDITOR_MODULE) as any
  button.remove()
  Client.createRoot(document.getElementById('root')!).render(React.createElement(editor.CanvasPanel, { sessionId: 'parent', bridge, initialProjectId: 'main' }))
})
