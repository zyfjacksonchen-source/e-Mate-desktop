import * as React from 'react'
import * as ReactDOM from 'react-dom'
import * as Client from 'react-dom/client'
import * as JSX from 'react/jsx-runtime'
import { ClientModuleSystem } from '../../../upstream/deepseek-harness/packages/client/modules/src/client/system.ts'
import { emptyPage, emptyProject } from '../src/contract.ts'
const modules = new ClientModuleSystem({ modules: [], staticModules: { react: React, 'react-dom': ReactDOM, 'react-dom/client': Client, 'react/jsx-runtime': JSX } })
let project = emptyProject('main')
project.pages.push({ ...emptyPage('legacy', '旧项目页'), html: '<script>window.canvasAttacked=true</script><h1>Legacy HTML</h1>', slide: true })
let revision = 'a'.repeat(64)
const bridge = { sessionId: 'parent', close() {}, subscribe() { return () => {} }, beforeLeave() { return () => {} }, async submit() { throw new Error('provider requests forbidden in local fixture') }, async stageImages() { return [] },
  async call(endpoint: string, payload: any = {}) {
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
