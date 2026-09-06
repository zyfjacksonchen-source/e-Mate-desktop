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
afterEach(()=>{cleanup();vi.useRealTimers()})
describe('native sprite host',()=>{
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
  it('native Settings controls are writable only when ready and errors stay visible',async()=>{
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{throw new Error('private error')})}
    const resources={...store({status:'unavailable'}),retry:vi.fn()}
    render(<PetsSection settings={settings} resources={resources as never}/>);fireEvent.click(screen.getByRole('checkbox'))
    await act(async()=>{});expect(settings.set).toHaveBeenCalledWith('enabled',false);expect(screen.getByText('设置未保存，请重试。')).toBeTruthy();expect(screen.queryByText('private error')).toBeNull()
    fireEvent.click(screen.getByRole('button',{name:'重新加载资源'}));expect(resources.retry).toHaveBeenCalledTimes(1)
  })
  it('resolved native write failures restore unchanged coordinates and report unsaved settings',async()=>{
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{})}
    const projection=store(pause)
    const resources={...store({status:'ready',pet:pet()}),start:vi.fn(),pause:vi.fn()}
    const view=render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings} details={{openTaskDetails:vi.fn()}}/>)
    const button=screen.getByRole('button');const original=button.style.left
    fireEvent.keyDown(button,{key:'ArrowRight'});expect(button.style.left).not.toBe(original)
    await act(async()=>{});expect(button.style.left).toBe(original);expect(screen.getByText('位置未保存')).toBeTruthy()
    view.unmount()
    render(<PetsSection settings={settings} resources={resources as never}/>);fireEvent.click(screen.getByRole('checkbox'))
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
    fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('checkbox'))
    await act(async()=>{});await act(async()=>{finishFirst()});expect(screen.queryByText('设置未保存，请重试。')).toBeNull()
    let finishLast:()=>void=()=>{}
    settings.set.mockImplementationOnce(()=>new Promise<void>(resolve=>{finishLast=resolve}))
    fireEvent.click(screen.getByRole('checkbox'));view.unmount()
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
    fireEvent.click(screen.getByRole('checkbox'));await act(async()=>{});expect(resources.retry).toHaveBeenCalledTimes(2)
  })
  it('first-response or hidden state cancels idle asset loading, with no timer left after disposal',()=>{
    const projection=store({...pause,firstResponsePending:true})
    const settings={...store({status:'ready',writable:true,value:{enabled:true,position:{x:0.5,y:0.5}}}),set:vi.fn(async()=>{})}
    const resources={...store({status:'idle'}),start:vi.fn(),pause:vi.fn()}
    const view=render(<PetOverlaySlot projection={projection as never} resources={resources as never} settings={settings} details={{openTaskDetails:vi.fn()}}/>);
    act(()=>{vi.advanceTimersByTime(3000)});expect(resources.start).not.toHaveBeenCalled()
    act(()=>{projection.set(pause)});expect(vi.getTimerCount()).toBe(1)
    act(()=>{projection.set({...pause,firstResponsePending:true,revision:2})});act(()=>{vi.advanceTimersByTime(3000)});expect(resources.start).not.toHaveBeenCalled()
    view.unmount();expect(vi.getTimerCount()).toBe(0)
  })
})
