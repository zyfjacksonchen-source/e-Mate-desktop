import { BufferAttribute, BufferGeometry, CanvasTexture, Color, LineBasicMaterial, LineSegments, PerspectiveCamera, Points, PointsMaterial, Raycaster, Scene, Vector2, Vector3, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { MAX_NODES, type KnowledgeEdge, type KnowledgeNode } from '../contract.ts'
export interface GraphController { update(nodes: KnowledgeNode[], edges: KnowledgeEdge[], selected?: string): void; focus(id: string): void; reset(): void; resize(): void; dispose(): void }

/** Positions are stable visual layout only. Every rendered point is one real returned node. */
export function nodePosition(id: string, layer: string) {
  let seed = 2166136261
  for (const character of id) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0
  const fraction = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const azimuth = fraction() * Math.PI * 2, elevation = (fraction() - .5) * 2.2, radius = 1.1 + fraction() * 2.2
  const offset = layer === 'expert' ? -2.8 : layer === 'case' ? 2.8 : 0
  return new Vector3(Math.cos(azimuth) * radius + offset, Math.sin(azimuth) * radius, elevation)
}
export function createGraph(container: HTMLElement, onSelect: (id: string) => void, onUnavailable: () => void): GraphController {
  const renderer = new WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.5))
  renderer.domElement.setAttribute('aria-hidden', 'true')
  renderer.domElement.style.touchAction = 'none'
  container.append(renderer.domElement)
  const scene = new Scene(), camera = new PerspectiveCamera(45, 1, .1, 100)
  camera.position.set(0, 0, 9)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = false; controls.minDistance = 4; controls.maxDistance = 28
  const sprite = document.createElement('canvas'); sprite.width = sprite.height = 32
  const paint = sprite.getContext('2d')
  if (!paint) { controls.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); throw Error('图形绘制不可用。') }
  const gradient = paint.createRadialGradient(16, 16, 0, 16, 16, 16)
  gradient.addColorStop(0, '#fff'); gradient.addColorStop(.3, '#fff'); gradient.addColorStop(1, '#ffffff00'); paint.fillStyle = gradient; paint.fillRect(0, 0, 32, 32)
  const texture = new CanvasTexture(sprite)
  const geometry = new BufferGeometry(), material = new PointsMaterial({ map: texture, depthWrite: false, size: .22, transparent: true, opacity: .9, vertexColors: true, sizeAttenuation: true })
  const points = new Points(geometry, material); scene.add(points)
  const lineGeometry = new BufferGeometry(), lineMaterial = new LineBasicMaterial({ transparent: true, opacity: .035 })
  const lines = new LineSegments(lineGeometry, lineMaterial); scene.add(lines)
  const focusGeometry = new BufferGeometry(), focusMaterial = new PointsMaterial({ map: texture, depthWrite: false, size: .44, transparent: true, opacity: 1, color: '#e77638', sizeAttenuation: true })
  const highlight = new Points(focusGeometry, focusMaterial); scene.add(highlight)
  const raycaster = new Raycaster(); raycaster.params.Points = { threshold: .14 }
  let activeSelection: string | undefined
  let nodes: KnowledgeNode[] = [], positions = new Map<string, Vector3>(), frame = 0, disposed = false
  let pointerStart: { x: number; y: number } | undefined
  const render = () => {
    frame = 0
    if (!disposed && document.visibilityState !== 'hidden') { try { renderer.render(scene, camera) } catch { onUnavailable() } }
  }
  const schedule = () => { if (!disposed && !frame && document.visibilityState !== 'hidden') frame = requestAnimationFrame(render) }
  const resize = () => {
    const { width, height } = container.getBoundingClientRect()
    if (!width || !height) return
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height, false); schedule()
  }
  const refreshTheme = () => {
    const dark = document.body.hasAttribute('data-ds-dark-theme')
    const ink = new Color(dark ? '#dddde1' : '#53545c')
    material.color.copy(ink); lineMaterial.color.copy(activeSelection ? new Color('#e77638') : ink); schedule()
  }
  const resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container)
  const themeObserver = new MutationObserver(refreshTheme); themeObserver.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })
  const visibility = () => { if (document.visibilityState === 'hidden') { cancelAnimationFrame(frame); frame = 0 } else schedule() }
  const lost = (event: Event) => { event.preventDefault(); onUnavailable() }
  const down = (event: PointerEvent) => { pointerStart = { x: event.clientX, y: event.clientY } }
  const up = (event: PointerEvent) => {
    const start = pointerStart; pointerStart = undefined
    if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) return
    const rect = renderer.domElement.getBoundingClientRect()
    const pointer = new Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1)
    raycaster.setFromCamera(pointer, camera)
    const hit = raycaster.intersectObject(points)[0]
    if (hit?.index !== undefined && nodes[hit.index]) onSelect(nodes[hit.index]!.id)
  }
  controls.addEventListener('change', schedule)
  document.addEventListener('visibilitychange', visibility)
  renderer.domElement.addEventListener('webglcontextlost', lost)
  renderer.domElement.addEventListener('pointerdown', down)
  renderer.domElement.addEventListener('pointerup', up)
  refreshTheme(); resize()
  return {
    resize,
    reset() { controls.reset(); schedule() },
    update(next, edges, selected) {
      if (next.length > MAX_NODES) throw Error('知识节点超过视图上限。')
      activeSelection = selected; lineMaterial.opacity = selected ? .42 : .035
      lineMaterial.color.set(selected ? '#e77638' : document.body.hasAttribute('data-ds-dark-theme') ? '#dddde1' : '#53545c')
      nodes = next; positions = new Map(next.map(node => [node.id, nodePosition(node.id, node.layer)]))
      geometry.setAttribute('position', new BufferAttribute(new Float32Array(next.flatMap(node => positions.get(node.id)!.toArray())), 3))
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(next.flatMap(node => new Color(node.id === selected ? '#e77638' : '#ffffff').toArray())), 3))
      geometry.computeBoundingSphere()
      lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(edges.filter(edge => positions.has(edge.from) && positions.has(edge.to) && (!selected || edge.from === selected || edge.to === selected)).flatMap(edge => [...positions.get(edge.from)!.toArray(), ...positions.get(edge.to)!.toArray()])), 3))
      const focused = selected ? positions.get(selected) : undefined
      focusGeometry.setAttribute('position', new BufferAttribute(new Float32Array(focused ? focused.toArray() : []), 3))
      focusGeometry.computeBoundingSphere(); lineGeometry.computeBoundingSphere(); schedule()
    },
    focus(id) { const point = positions.get(id); if (!point) return; controls.target.copy(point); camera.position.copy(point).add(new Vector3(0, 0, 8)); controls.update(); schedule() },
    dispose() {
      disposed = true; cancelAnimationFrame(frame); controls.removeEventListener('change', schedule); controls.dispose()
      document.removeEventListener('visibilitychange', visibility); resizeObserver.disconnect(); themeObserver.disconnect()
      renderer.domElement.removeEventListener('webglcontextlost', lost); renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', up)
      geometry.dispose(); lineGeometry.dispose(); focusGeometry.dispose(); material.dispose(); lineMaterial.dispose(); focusMaterial.dispose(); texture.dispose(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove()
    },
  }
}
