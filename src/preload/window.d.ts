import { ElectronAPI } from '@electron-toolkit/preload'

export interface ServerInfo {
  host: string
  port: number
  url: string
  requestedPort: number
  portChanged: boolean
  mode: 'desktop' | 'server'
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: {
      getServerInfo: () => Promise<ServerInfo | null>
      selectDataDirectory: () => Promise<string | null>
      relaunchApp: () => Promise<void>
    }
  }
}

export {}
