/** Host-only integration: no studio, settings, sidebar, template sync or updater. */
import type { Context } from '@deepseek-ai/cordis'
import { createImageHost, IMAGE_MODEL, managedChannel, managedRoot } from './host.ts'
import { registerAgentImageTools } from './upstream/agent-image-tools.ts'
export { createImageHost, IMAGE_MODEL, managedChannel, managedRoot, sessionImageRefs } from './host.ts'
export const name = 'emate-imagegen'
export const inject = ['tools', 'jobs', 'attachments', 'emateIdentity', 'emateModelPolicy', 'emateCapabilities']
export interface Config { rootUrl?: string }

export function apply(ctx: Context, config: Config = {}): void {
  const hostContext = ctx as any
  let root: URL | undefined, error: string | undefined
  try { root = managedRoot(config.rootUrl) } catch (failure) { error = failure instanceof Error ? failure.message : String(failure) }
  ctx.effect(() => hostContext.emateCapabilities.register({ id: 'image-generation', title: '生图 / 改图',
    summary: '使用企业下发的固定图像模型，图片保存在原生会话、画廊和画布。', icon_key: 'image', order: 10, actions: [],
    status: async () => {
      if (!root) return { state: config.rootUrl ? 'blocked' : 'setup-required', detail: error, action_ids: [] }
      try {
        await hostContext.emateModelPolicy.assertModel(IMAGE_MODEL)
        return { state: 'ready', detail: IMAGE_MODEL, action_ids: [] }
      } catch { return { state: 'blocked', detail: '当前账号暂不可使用图像模型。', action_ids: [] } }
    },
  }), 'dsh-imagegen: e-Mate capability')
  if (!root) return
  const { runtime, host } = createImageHost(hostContext, root)
  ctx.effect(() => hostContext.jobs.attachController('emate-image'), 'dsh-imagegen: native Job controller')
  ctx.effect(() => registerAgentImageTools(ctx, runtime, () => ({ enabled: true, allowAgentImageGeneration: true,
    channels: [managedChannel(root!)], defaultChannelId: 'emate-managed' }), host), 'dsh-imagegen: native Tools')
}
