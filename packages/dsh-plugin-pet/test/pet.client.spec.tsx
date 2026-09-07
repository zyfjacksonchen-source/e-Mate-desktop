// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { PetOverlay } from '../src/client/PetOverlay.tsx'
import { PetSprite, lookDirection } from '../src/client/PetSprite.tsx'
import { PetsSection } from '../src/client/PetsSection.tsx'
import { PetOverlaySlot } from '../src/client/PetOverlaySlot.tsx'
import { setPetSetting } from '../src/client/settings-write.ts'
import { baseManifest, officeManifest, store } from './support.mjs'
const pet = () => ({base:baseManifest(),baseUrl:'blob:base',office:officeManifest(),officeUrl:'blob:office',extensionStatus:'ready' as const,dispose(){}})
const pause = { taskId:'a',revision:1,firstResponsePending:false,window:{visible:true,minimized:false} }
beforeEach(()=>{
  vi.useFakeTimers()
  Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'})
  Object.defineProperty(window,'matchMedia',{configurable:true,value:()=>({matches:false,addEventListener:vi.fn(),removeEventListener:vi.fn()})})
  class TestPointerEvent extends MouseEvent { readonly pointerId: number; constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1 } }
  Object.defineProperty(window,'PointerEvent',{configurable:true,value:TestPointerEvent})
  Object.defineProperty(HTMLElement.prototype,'setPointerCapture',{configurable:true,value:vi.fn()})
  Object.defineProperty(HTMLElement.prototype,'hasPointerCapture',{configurable:true,value:()=>true})
  Object.defineProperty(HTMLElement.prototype,'releasePointerCapture',{configurable:true,value:vi.fn()})
})
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks()})
describe('native sprite host',()=>{
  it('free motion varies without changing the real task or repeating poses within a cycle',()=>{
    vi.spyOn(Math,'random').mockReturnValue(0)
    const props={pet:pet(),scene:'terminal' as const,paused:false,freeMotion:true,position:{x:.5,y:.5},save:async()=>{},open:vi.fn(),taskId:'task-a'}
    const view=render(<PetOverlay {...props}/>), seen=new Set<string>()
    for(let i=0;i<6;i++) {
      act(()=>{vi.advanceTimersByTime(8000)})
      const motion=view.container.querySelector('[data-pet-scene]')!.getAttribute('data-pet-scene')!
      expect(seen.has(motion)).toBe(false);seen.add(motion)
      expect(screen.getByRole('button').title).toBe('运行终端')
    }
    const previous=view.container.querySelector('[data-pet-scene]')!.getAttribute('data-pet-scene')
    view.rerender(<PetOverlay {...props} scene="spreadsheet"/>)
    expect(view.container.querySelector('[data-pet-scene]')!.getAttribute('data-pet-scene')).toBe(previous)
    fireEvent.click(screen.getByRole('button'));expect(props.open).toHaveBeenCalledWith('task-a')
    view.rerender(<PetOverlay {...props} paused/>)
    expect(vi.getTimerCount()).toBe(0)
    act(()=>{vi.advanceTimersByTime(60000)})
    expect(view.container.querySelector('[data-pet-scene]')!.getAttribute('data-pet-scene')).toBe(previous)
  })
  it('all look directions have their exact clockwise cells; neutral remains idle',()=>{
    expect(lookDirection(0,-40)).toBe(0);expect(lookDirection(40,0)).toBe(4);expect(lookDirection(0,40)).toBe(8);expect(lookDirection(-40,0)).toBe(12);expect(lookDirection(0,0)).toBeNull()
    const view=render(<PetSprite pet={pet()} scene="idle" drag={null} look={15} paused={false}/>)
    expect(view.container.querySelector('span')?.getAttribute('data-frame-row')).toBe('10');expect(view.container.querySelector('span')?.getAttribute('data-frame-column')).toBe('7');expect(vi.getTimerCount()).toBe(0)
  })
  it('pausing/unmount clears every animation timer and valid base remains a fallback',()=>{
    const source=pet();const view=render(<PetSprite pet={source} scene="terminal" drag={null} look={null} paused={false}/>)
    expect(vi.getTimerCount()).toBe(1);act(()=>{vi.advanceTimersByTime(150)});expect(view.container.querySelector('span')?.getAttribute('data-frame-column')).toBe('1')
    view.rerender(<PetSprite pet={source} scene="terminal" drag={null} look={null} paused={true}/>);expect(vi.getTimerCount()).toBe(0)
    view.rerender(<PetSprite pet={{...source,office:undefined,officeUrl:undefined}} scene="terminal" drag={null} look={null} paused={true}/>);expect(view.container.querySelector('span')?.getAttribute('data-frame-row')).toBe('7')
    view.unmount();expect(vi.getTimerCount()).toBe(0)
  })
  it('keyboard movement is persisted through the native scope callback; click opens current details',async()=>{
    const save=vi.fn(async(_position: {x:number;y:number})=>{});const open=vi.fn();render(<PetOverlay pet={pet()} scene="goal" paused position={{x:0.5,y:0.5}} save={save} open={open} taskId="task-a"/>)
    const button=screen.getByRole('button');expect(button.style.width).toBe('112px');fireEvent.keyDown(button,{key:'ArrowRight'});expect(save).toHaveBeenCalledTimes(1);expect(save.mock.calls[0]![0].x).toBeGreaterThan(0.5)
    fireEvent.click(button);expect(open).toHaveBeenCalledWith('task-a')
  })
  it('completed Office activity is labelled as a recent completion',()=>{
    render(<PetOverlay pet={pet()} scene="document-read" completed paused position={{x:0.5,y:0.5}} save={async()=>{}} open={()=>{}} taskId="a"/>)
    expect(screen.getByRole('button').title).toBe('最近完成：阅读文档')
    expect(screen.getByRole('button').getAttribute('aria-label')).toContain('最近完成：阅读文档')
  })
  it('drag completion persists once and does not open details; late failed saves do not roll back newer moves',async()=>{
    let rejectFirst: (error: Error) => void = () => {}
    const save=vi.fn().mockImplementationOnce(()=>new Promise((_resolve,reject)=>{rejectFirst=reject})).mockResolvedValue(undefined)
    const open=vi.fn();render(<PetOverlay pet={pet()} scene="idle" paused position={{x:0.5,y:0.5}} save={save} open={open} taskId="a"/>)
    const button=screen.getByRole('button')
    fireEvent.pointerDown(button,{button:0,pointerId:1,clientX:500,clientY:400})
    fireEvent.pointerMove(button,{pointerId:1,clientX:530,clientY:410})
    fireEvent.pointerUp(button,{pointerId:1,clientX:530,clientY:410})
    expect(save).toHaveBeenCalledTimes(1);fireEvent.click(button);expect(open).not.toHaveBeenCalled()
    fireEvent.keyDown(button,{key:'ArrowRight'});const latest=button.style.left
    await act(async()=>{rejectFirst(new Error('late failure'))})
    expect(button.style.left).toBe(latest);expect(screen.queryByText('位置未保存')).toBeNull()
    fireEvent.click(button);expect(open).toHaveBeenCalledWith('a')
  })
  it('old settings acknowledgements cannot snap a later queued move back',async()=>{
    const completions:Array<()=>void>=[]
    const save=vi.fn((_point:{x:number;y:number})=>new Promise<void>(resolve=>completions.push(resolve)))
    const props={pet:pet(),scene:'idle' as const,paused:true,position:{x:0.5,y:0.5},save,open:vi.fn(),taskId:'a'}
    const view=render(<PetOverlay {...props}/>);const button=screen.getByRole('button')
    fireEvent.keyDown(button,{key:'ArrowRight'});const first=save.mock.calls[0]![0]
    fireEvent.keyDown(button,{key:'ArrowRight'});const second=save.mock.calls[1]![0];const latest=button.style.left
    view.rerender(<PetOverlay {...props} position={first}/>);expect(button.style.left).toBe(latest)
    await act(async()=>completions[0]!());expect(button.style.left).toBe(latest)
    view.rerender(<PetOverlay {...props} position={second}/>)
    await act(async()=>completions[1]!());expect(button.style.left).toBe(latest)
    expect(screen.queryByText('位置未保存')).toBeNull()
  })
  it('resize cancels a captured gesture and preserves normalized saved coordinates without opening details',()=>{
    const save=vi.fn(async()=>{});const open=vi.fn();const width=window.innerWidth
    const view=render(<PetOverlay pet={pet()} scene="idle" paused position={{x:0.5,y:0.5}} save={save} open={open} taskId="a"/>)
    const button=screen.getByRole('button')
    fireEvent.pointerDown(button,{button:0,pointerId:3,clientX:100,clientY:100})
    fireEvent.pointerMove(button,{pointerId:3,clientX:180,clientY:120})
    try {
      Object.defineProperty(window,'innerWidth',{configurable:true,value:640})
      fireEvent(window,new Event('resize'))
      expect(parseFloat(button.style.left)).toBe((640-112)*0.5)
      fireEvent.pointerUp(button,{pointerId:3,clientX:180,clientY:120})
      fireEvent.click(button);expect(open).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
      expect(HTMLElement.prototype.releasePointerCapture).toHaveBeenCalledWith(3)
    } finally { Object.defineProperty(window,'innerWidth',{configurable:true,value:width});view.unmount() }
  })
  it('right-click and keyboard menu keep focus, settings and persistent close on the existing owners',async()=>{
    const cell=store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}})
    const settings={...cell,set:vi.fn(async(key:string,value:unknown)=>{cell.set({...cell.getSnapshot(),value:{...cell.getSnapshot().value,[key]:value}})})}
    const projection=store(pause);const resources={...store({status:'ready',pet:pet()}),start:vi.fn(),pause:vi.fn()}
    const details={openTaskDetails:vi.fn(),openPetSettings:vi.fn(),readWorkFacts:()=>({delivered:false})}
    const view=render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings as never} details={details}/>)
    const button=screen.getByRole('button')
    fireEvent.contextMenu(button,{clientX:window.innerWidth-1,clientY:window.innerHeight-1})
    expect(screen.getByRole('menu',{name:'小芯菜单'})).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'小芯设置'}))
    fireEvent.keyDown(screen.getByRole('menu'),{key:'End'})
    expect(document.activeElement).toBe(screen.getByRole('menuitem',{name:'关闭小芯'}))
    fireEvent.keyDown(screen.getByRole('menu'),{key:'Escape'})
    expect(screen.queryByRole('menu')).toBeNull();expect(document.activeElement).toBe(button)
    fireEvent.keyDown(button,{key:'F10',shiftKey:true})
    fireEvent.click(screen.getByRole('menuitem',{name:'小芯设置'}))
    expect(details.openPetSettings).toHaveBeenCalledTimes(1);expect(details.openTaskDetails).not.toHaveBeenCalled()
    fireEvent.contextMenu(button)
    fireEvent.click(screen.getByRole('menuitem',{name:'关闭小芯'}))
    await act(async()=>{})
    expect(settings.set).toHaveBeenCalledWith('enabled',false)
    expect(cell.getSnapshot().value.enabled).toBe(false);expect(view.container.querySelector('[data-pet-id]')).toBeNull()
    view.unmount()
    render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings as never} details={details}/>)
    expect(screen.queryByRole('button')).toBeNull()
  })
  it('context close verifies persistence, prevents duplicate writes and leaves failures retryable',async()=>{
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{})}
    const resources={...store({status:'ready',pet:pet()}),start:vi.fn(),pause:vi.fn()}
    render(<PetOverlaySlot projection={store(pause) as never} resources={resources as never} settings={settings} details={{openTaskDetails:vi.fn(),openPetSettings:vi.fn(),readWorkFacts:()=>({delivered:false})}}/>)
    fireEvent.contextMenu(screen.getByRole('button'))
    const close=screen.getByRole('menuitem',{name:'关闭小芯'})
    act(()=>{fireEvent.click(close);fireEvent.click(close)})
    await act(async()=>{})
    expect(settings.set).toHaveBeenCalledTimes(1)
    expect(screen.getByText('关闭未保存，请重试。')).toBeTruthy()
    expect(screen.getByRole('menuitem',{name:'关闭小芯'}).hasAttribute('disabled')).toBe(false)
    expect(document.querySelector('[data-pet-id]')).toBeTruthy()
  })
  it('menu resets persisted position and keeps settings accessible when movement is read-only',async()=>{
    const save=vi.fn(async()=>{});const openSettings=vi.fn()
    const props={pet:pet(),scene:'idle' as const,paused:true,position:{x:0.5,y:0.5},save,open:vi.fn(),taskId:null,openSettings,close:vi.fn(async()=>{})}
    const view=render(<PetOverlay {...props}/>)
    fireEvent.keyDown(screen.getByRole('button'),{key:'ContextMenu'})
    fireEvent.click(screen.getByRole('menuitem',{name:'重置位置'}))
    expect(save).toHaveBeenCalledWith({x:0.97,y:0.97});await act(async()=>{})
    view.rerender(<PetOverlay {...props} movable={false}/>)
    fireEvent.contextMenu(screen.getByRole('button'))
    expect(screen.getByRole('menuitem',{name:'关闭小芯'}).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem',{name:'重置位置'}).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('menuitem',{name:'小芯设置'}));expect(openSettings).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button'));expect(props.open).not.toHaveBeenCalled()
  })
  it('native Settings controls are writable only when ready and errors stay visible',async()=>{
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{throw new Error('private error')})}
    const resources={...store({status:'unavailable'}),retry:vi.fn()}
    render(<PetsSection settings={settings} resources={resources as never}/>);expect(screen.getByRole('switch',{name:'启用小芯智能伙伴'}).hasAttribute('aria-describedby')).toBe(true);fireEvent.click(screen.getByRole('switch'))
    await act(async()=>{});expect(settings.set).toHaveBeenCalledWith('enabled',false);expect(screen.getByText('设置未保存，请重试。')).toBeTruthy();expect(screen.queryByText('private error')).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'重新加载资源'}));expect(resources.retry).toHaveBeenCalledTimes(1)
  })
  it('resolved native write failures restore unchanged coordinates and report unsaved settings',async()=>{
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{})}
    const projection=store(pause)
    const resources={...store({status:'ready',pet:pet()}),start:vi.fn(),pause:vi.fn()}
    const view=render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings} details={{openTaskDetails:vi.fn(),readWorkFacts:()=>({delivered:false})}}/>)
    const button=screen.getByRole('button');const original=button.style.left
    fireEvent.keyDown(button,{key:'ArrowRight'});expect(button.style.left).not.toBe(original)
    await act(async()=>{});expect(button.style.left).toBe(original);expect(screen.getByText('位置未保存')).toBeTruthy()
    view.unmount()
    render(<PetsSection settings={settings} resources={resources as never}/>);fireEvent.click(screen.getByRole('switch'))
    await act(async()=>{});expect(screen.getByText('设置未保存，请重试。')).toBeTruthy()
  })
  it('verified writes use native readback; stale and unmounted gestures cannot report failure or retry resources',async()=>{
    const cell=store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}})
    const settings={...cell,set:vi.fn(async()=>{})}
    let finishFirst:()=>void=()=>{}
    settings.set.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishFirst=resolve}))
    settings.set.mockImplementationOnce(async()=>{cell.set({...settings.getSnapshot(),value:{...settings.getSnapshot().value,enabled:false}})})
    const resources={...store({status:'ready',pet:{...pet(),extensionStatus:'unavailable'}}),retry:vi.fn()}
    const view=render(<PetsSection settings={settings} resources={resources as never}/>);
    fireEvent.click(screen.getByRole('switch'));fireEvent.click(screen.getByRole('switch'))
    await act(async()=>{});await act(async()=>{finishFirst()});expect(screen.queryByText('设置未保存，请重试。')).toBeNull()
    let finishLast:()=>void=()=>{}
    settings.set.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishLast=resolve}))
    fireEvent.click(screen.getByRole('switch'));view.unmount()
    await act(async()=>{cell.set({...settings.getSnapshot(),value:{...settings.getSnapshot().value,enabled:true}});finishLast()})
    expect(resources.retry).not.toHaveBeenCalled()
    await expect(setPetSetting(settings,'enabled',true)).resolves.toBeUndefined()
  })
  it('office extension failures expose retry and re-enabling retries an unavailable extension',async()=>{
    const cell=store({status:'ready',writable:true,value:{enabled:false,position:{x:0.5,y:0.5}}})
    const settings={...cell,set:vi.fn(async()=>{cell.set({...settings.getSnapshot(),value:{...settings.getSnapshot().value,enabled:true}})})}
    const resources={...store({status:'ready',pet:{...pet(),extensionStatus:'unavailable'}}),retry:vi.fn()}
    render(<PetsSection settings={settings} resources={resources as never}/>);
    fireEvent.click(screen.getByRole('button',{name:'重新加载办公动画'}));expect(resources.retry).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('switch'));await act(async()=>{});expect(resources.retry).toHaveBeenCalledTimes(2)
  })
  it('first-response or hidden state cancels idle asset loading, with no timer left after disposal',()=>{
    const projection=store({...pause,firstResponsePending:true})
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{})}
    const resources={...store({status:'idle'}),start:vi.fn(),pause:vi.fn()}
    const view=render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings} details={{openTaskDetails:vi.fn(),readWorkFacts:()=>({delivered:false})}}/>);
    act(()=>{vi.advanceTimersByTime(3000)});expect(resources.start).not.toHaveBeenCalled()
    act(()=>{projection.set(pause)});expect(vi.getTimerCount()).toBe(1)
    act(()=>{projection.set({...pause,firstResponsePending:true,revision:2})});act(()=>{vi.advanceTimersByTime(3000)});expect(resources.start).not.toHaveBeenCalled()
    view.unmount();expect(vi.getTimerCount()).toBe(0)
  })
})
