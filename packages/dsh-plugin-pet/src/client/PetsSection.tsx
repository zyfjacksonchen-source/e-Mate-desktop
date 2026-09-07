/** One native Settings section; writes are explicit user actions only. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { decodeSettings } from '../settings.ts'
import type { PetSettingsScope } from './runtime-types.ts'
import type { PetResources } from './resources.ts'
import { setPetSetting } from './settings-write.ts'
import css from './PetsSection.module.css'
export function PetsSection({ settings, resources }: { settings: PetSettingsScope; resources: PetResources }) {
  const snapshot = useSyncExternalStore(useCallback(listener => settings.subscribe(listener), [settings]), useCallback(() => settings.getSnapshot(), [settings]))
  const assets = useSyncExternalStore(resources.subscribe, resources.getSnapshot, resources.getSnapshot)
  const [failed, setFailed] = useState(false)
  const writeRevision = useRef(0)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const value = decodeSettings(snapshot.value)
  const saveEnabled = (enabled: boolean) => {
    const revision = ++writeRevision.current
    setFailed(false)
    void setPetSetting(settings, 'enabled', enabled).then(() => {
      if (!mounted.current || revision !== writeRevision.current) return
      const current = resources.getSnapshot()
      if (enabled && (current.status === 'unavailable' || current.pet?.extensionStatus === 'unavailable')) resources.retry()
    }, () => { if (mounted.current && revision === writeRevision.current) setFailed(true) })
  }
  return <section className={css.section} aria-labelledby="emate-pet-title">
    <h2 id="emate-pet-title">小芯智能伙伴</h2>
    <label className={css.toggle}><span>启用小芯<span id="emate-pet-description" className={css.note}>跟随任务状态，支持拖动。关闭后可在这里重新开启。</span></span>
      <span className={css.controls}><span className={css.status}>{value.enabled ? '已开启' : '已关闭'}</span>
        <input type="checkbox" role="switch" aria-label="启用小芯智能伙伴" aria-describedby="emate-pet-description" checked={value.enabled} disabled={snapshot.status !== 'ready' || !snapshot.writable}
          onChange={event => saveEnabled(event.currentTarget.checked)} />
      </span>
    </label>
    {failed && <p role="status">设置未保存，请重试。</p>}
    {assets.status === 'unavailable' && <div role="status">小芯资源暂不可用。<button type="button" className={css.retry} onClick={resources.retry}>重新加载资源</button></div>}
    {assets.pet?.extensionStatus === 'unavailable' && <p className={css.note}>办公动画暂不可用，正在使用标准动作。<button type="button" className={css.retry} onClick={resources.retry}>重新加载办公动画</button></p>}
  </section>
}
