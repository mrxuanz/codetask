import { contextBridge, ipcRenderer } from 'electron'

export interface ServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: 'desktop' | 'server'
}

const api = {
  getServerInfo: (): Promise<ServerInfo | null> => ipcRenderer.invoke('get-server-info')
}

// contextIsolation is always enabled in src/main; expose only the used bridge.
contextBridge.exposeInMainWorld('api', api)
