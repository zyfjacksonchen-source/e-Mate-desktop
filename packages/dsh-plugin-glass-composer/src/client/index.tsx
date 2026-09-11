import { useCallback, useState, useSyncExternalStore } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { IconSettingsOutline16, Menu, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import {
  DEFAULT_GLASS_PALETTE,
  GLASS_SETTINGS_NAMESPACE,
  PALETTE_FIELD,
  isGlassPalette,
  type GlassPalette,
  type GlassSettings,
} from '../settings.ts'
import css from './style.module.css'

export const inject = ['slots', 'connection', 'remote', 'settingsScope']

const PALETTE_ITEMS: readonly MenuEntry[] = [
  { id: 'brand', label: '品牌橙光' },
  { id: 'rgb', label: 'RGB 彩光' },
  { id: 'violet', label: '紫色流光' },
  { id: 'cyan-pink', label: '青粉流光' },
  { type: 'separator', id: 'effect-separator' },
  { id: 'off', label: '关闭外沿动效' },
]

export function GlassComposerControl({ scope }: { readonly scope: SettingsScope<GlassSettings> }) {
  const [open, setOpen] = useState(false)
  const subscribe = useCallback((listener: () => void) => scope.subscribe(listener), [scope])
  const getSnapshot = useCallback(() => scope.getSnapshot(), [scope])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const palette = isGlassPalette(snapshot.value?.palette) ? snapshot.value.palette : DEFAULT_GLASS_PALETTE

  return <span className={css.root} data-emate-glass-control="" data-emate-glass-palette={palette}>
    <Menu
      portal
      compact
      open={open}
      align="end"
      side="top"
      selectedId={palette}
      items={PALETTE_ITEMS}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        if (!isGlassPalette(id)) return
        setOpen(false)
        void scope.set(PALETTE_FIELD, id satisfies GlassPalette)
      }}
      anchor={<button
        type="button"
        className={css.button}
        aria-label="设置聊天框外沿动效"
        title="聊天框外沿动效"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={snapshot.status !== 'ready' || !snapshot.writable}
        onClick={() => { setOpen(value => !value) }}
      ><IconSettingsOutline16 size={16} /></button>}
    />
  </span>
}

export function apply(ctx: Context): void {
  const scope = ctx.settingsScope.bind<GlassSettings>({ namespace: GLASS_SETTINGS_NAMESPACE })
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'e-mate-glass-composer',
    order: 25,
    inject: () => ({ scope }),
  }, GlassComposerControl))
}
