/** One native Settings section; writes are explicit user actions only. */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { decodeSettings } from '../settings.ts'
import type { PetSettingsScope } from './runtime-types.ts'
import type { PetResources } from './resources.ts'
import css from './PetsSection.module.css'
export function PetsSection({ settings, resources }: { settings: PetSettingsScope; resources: PetResources }) {
  const snapshot = useSyncExternalStore(useCallback(listener => settings.subscribe(listener), [settings]), useCallback(() => settings.getSnapshot(), [settings]))
  const assets = useSyncExternalStore(resources.subscribe, resources.getSnapshot, resources.getSnapshot)
  const [failed, setFailed] = useState(false)
  const value = decodeSettings(snapshot.value)
  return <section className={css.section} aria-labelledby="emate-pet-title">
    <h2 id="emate-pet-title">桌面宠物</h2>
    <label className={css.toggle}><span>显示小芯<span className={css.note}>跟随当前任务状态，可拖动或使用方向键移动。</span></span>
      <input type="checkbox" aria-label="显示桌面宠物小芯" checked={value.enabled} disabled={snapshot.status !== 'ready' || !snapshot.writable}
        onChange={event => { const enabled = event.currentTarget.checked; setFailed(false); void settings.set('enabled', enabled).then(() => { if (enabled && resources.getSnapshot().status === 'unavailable') resources.retry() }, () => setFailed(true)) }} />
    </label>
    {failed && <p role="status">设置未保存，请重试。</p>}
    {assets.status === 'unavailable' && <div role="status">小芯资源暂不可用。<button type="button" className={css.retry} onClick={resources.retry}>重新加载资源</button></div>}
    {assets.pet?.extensionStatus === 'unavailable' && <p className={css.note}>办公动画暂不可用，正在使用标准动作。</p>}
  </section>
}
