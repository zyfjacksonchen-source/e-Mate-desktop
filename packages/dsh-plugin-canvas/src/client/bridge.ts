import { CHANNEL, imageRef, intentPrompt, type CanvasAsset, type CanvasIntent, type CanvasProject } from '../contract.ts'
import { base64, bytesOf, digest } from './model.ts'
export interface CanvasBridge {
  sessionId: string
  call(endpoint: string, payload?: Record<string, unknown>): Promise<any>
  submit(project: CanvasProject, intent: CanvasIntent, instruction: string): Promise<void>
  subscribe(listener: () => void): () => void
  stageImages(files: File[]): Promise<CanvasAsset[]>
  beforeLeave(handler: () => Promise<void>): () => void
  close(): void
}
export function createBridge(ctx: any, id: string, close: () => void, beforeLeave: CanvasBridge['beforeLeave']): CanvasBridge {
  const binding = () => {
    const value = ctx.sessions.binding(id)?.session
    if (!value) throw new Error('当前会话不可用。')
    return value
  }
  const call = async (endpoint: string, payload: Record<string, unknown> = {}) => {
    const response = await ctx.connection.rpc.call(CHANNEL, endpoint, { ...payload, session_id: id })
    if (!response?.ok) {
      const error = new Error(response?.error?.message ?? '画布请求未完成。')
      Object.assign(error, { code: response?.error?.code })
      throw error
    }
    return response.value
  }
  return {
    sessionId: id, call, close, beforeLeave,
    async stageImages(files) {
      if (files.length < 1 || files.length > 20) throw new Error('一次可添加 1 到 20 张图片。')
      const images = await Promise.all(files.map(async file => {
        if (file.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) throw new Error('图片格式或大小不受支持。')
        return { bytes_base64: base64(new Uint8Array(await file.arrayBuffer())), media_type: file.type, name: file.name }
      }))
      const result = await ctx.connection.rpc.call('/emate.fileImport', 'stage-images', { session_id: id, images })
      if (!result?.ok || result.value?.schema_version !== 1 || !Array.isArray(result.value.attachments)) throw new Error(result?.error?.message ?? '原生文件导入未接受图片。')
      return result.value.attachments.map((ref: unknown) => ({ ownerSessionId: id, ref: imageRef(ref) }))
    },
    subscribe(listener) {
      const offSession = binding().subscribe(listener)
      const offList = ctx.sessions.list.subscribe(listener)
      return () => { offSession(); offList() }
    },
    async submit(project, intent, instruction) {
      const content: any[] = [{ type: 'text', text: intentPrompt(project, intent, instruction) }]
      for (const sourceId of intent.sourceIds) {
        const result = await call('image', { project_id: project.id, attachment_id: sourceId })
        const bytes = bytesOf(result.bytes_base64)
        if (`sha256:${await digest(bytes)}` !== sourceId || bytes.byteLength !== result.ref.bytes) throw new Error('参考图附件校验失败。')
        content.push({ type: 'image', mediaType: result.ref.mediaType, data: base64(bytes), ...(result.ref.name ? { name: result.ref.name } : {}) })
      }
      // This is the native session input path; queue/Tool/approval/Job state remain in Harness.
      const result = await binding().prompt(content, 'queue')
      if (!result?.ok) throw new Error(result?.error?.message ?? '原生会话未接受请求。')
    },
  }
}
export interface CanvasOpenOptions { projectId?: string; attachment?: { ownerSessionId: string; attachmentId: string } }
export interface CanvasClientService {
  open(sessionId: string, options?: CanvasOpenOptions): Promise<void>
  insertAttachment(sessionId: string, ownerSessionId: string, attachmentId: string): Promise<void>
}
