import type { ServerInfo } from './index'

declare global {
  interface Window {
    api?: {
      getServerInfo: () => Promise<ServerInfo | null>
    }
  }
}

export {}
