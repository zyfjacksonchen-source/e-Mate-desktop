import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as Client from 'react-dom/client'
import * as JSX from 'react/jsx-runtime'
import { ClientModuleSystem } from '../../../upstream/deepseek-harness/packages/client/modules/src/client/system.ts'
import { insertAsset } from '../src/client/model.ts'
import { emptyPage, emptyProject } from '../src/contract.ts'
const modules = new ClientModuleSystem({ modules: [], staticModules: { react: React, 'react-dom': ReactDOM, 'react-dom/client': Client, 'react/jsx-runtime': JSX } })
const encoded = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0))
const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
const asset = { ownerSessionId: 'parent', ref: { attachmentId: `sha256:${hash}`, mediaType: 'image/png', bytes: bytes.length, width: 400, height: 300 } }
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
  await import(/* @vite-ignore */ new URL('/emate-canvas-assets/editor.js', location.origin).href)
  const editor = await modules.import('@e-mate/dsh-plugin-canvas/editor') as any
  button.remove()
  Client.createRoot(document.getElementById('root')!).render(React.createElement(editor.CanvasPanel, { sessionId: 'parent', bridge, initialProjectId: 'main' }))
})
