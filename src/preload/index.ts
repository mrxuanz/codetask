import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

export interface ServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: 'desktop' | 'server'
}

const api = {
  getServerInfo: (): Promise<ServerInfo | null> => ipcRenderer.invoke('get-server-info'),
  selectDataDirectory: (): Promise<string | null> => ipcRenderer.invoke('select-data-directory'),
  relaunchApp: (): Promise<void> => ipcRenderer.invoke('relaunch-app')
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  window.electron = electronAPI

  window.api = api
}
