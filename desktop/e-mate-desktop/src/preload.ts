/** Minimal context-isolated bridge for resolving operating-system drag payloads. */

import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  DESKTOP_BOOTSTRAP_BRIDGE,
  DESKTOP_NOTIFICATION_BRIDGE, DESKTOP_NOTIFICATION_OPEN, DESKTOP_NOTIFICATION_TAKE,
  type DesktopNotificationBridge,
  parseDesktopRendererBootstrapArgument,
} from './desktop-bootstrap-contract.ts'
import { DESKTOP_FILE_PATH_BRIDGE } from './file-path-bridge-contract.ts'
import {
  DESKTOP_UPDATE_RUN_INTERACTIVE,
  DESKTOP_UPDATE_TRIGGER_BRIDGE,
  type DesktopUpdateTriggerBridge,
} from './desktop-update-trigger-contract.ts'
import {
  DESKTOP_RESOURCE_BRIDGE,
  DESKTOP_RESOURCE_RUN,
  type DesktopResourceBridge,
} from './desktop-resource-bridge-contract.ts'

contextBridge.exposeInMainWorld(
  DESKTOP_BOOTSTRAP_BRIDGE,
  parseDesktopRendererBootstrapArgument(process.argv),
)

contextBridge.exposeInMainWorld(DESKTOP_FILE_PATH_BRIDGE, {
  /** Resolve only genuine disk-backed Web File objects selected by the operator. */
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
})

const resources: DesktopResourceBridge = {
  run: async request => { await ipcRenderer.invoke(DESKTOP_RESOURCE_RUN, request) },
}
contextBridge.exposeInMainWorld(DESKTOP_RESOURCE_BRIDGE, resources)

const updates: DesktopUpdateTriggerBridge = {
  runInteractiveUpdate: async () => { await ipcRenderer.invoke(DESKTOP_UPDATE_RUN_INTERACTIVE) },
}
contextBridge.exposeInMainWorld(DESKTOP_UPDATE_TRIGGER_BRIDGE, updates)

const notifications: DesktopNotificationBridge = {
  subscribe(listener) {
    let active = true
    const take = (): void => {
      void ipcRenderer.invoke(DESKTOP_NOTIFICATION_TAKE).then((id: unknown) => {
        if (active && typeof id === 'string' && id.length > 0 && id.length <= 4096) listener(id)
      }).catch(() => {})
    }
    ipcRenderer.on(DESKTOP_NOTIFICATION_OPEN, take)
    take()
    return () => { active = false; ipcRenderer.off(DESKTOP_NOTIFICATION_OPEN, take) }
  },
}
contextBridge.exposeInMainWorld(DESKTOP_NOTIFICATION_BRIDGE, notifications)
