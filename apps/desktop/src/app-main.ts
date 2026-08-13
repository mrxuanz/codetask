import { app, shell, BrowserWindow } from 'electron'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { createShutdownSignalHandler } from '@codetask/service-bootstrap'
import { startDesktopService, type DesktopServiceHandle } from './desktop-service'
import { runPackagedSmoke } from './package-smoke'

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const smokeTest = process.argv.includes('--smoke-test')
if (smokeTest) {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let service: DesktopServiceHandle | null = null

function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl)
    return ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)
  } catch {
    return false
  }
}

function isSameAppOrigin(navigationUrl: string, appOrigin: string): boolean {
  try {
    return new URL(navigationUrl).origin === appOrigin
  } catch {
    return false
  }
}

function createWindow(serverUrl: string): void {
  const appOrigin = new URL(serverUrl).origin

  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      contextIsolation: true,
      sandbox: true
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isAllowedExternalUrl(details.url)) {
      void shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isSameAppOrigin(navigationUrl, appOrigin)) {
      event.preventDefault()
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.loadURL(serverUrl)
}

let shutdownPromise: Promise<void> | null = null
function gracefulShutdownFromApp(): Promise<void> {
  shutdownPromise ??= (async () => {
    if (service) {
      await service.stop()
      service = null
    }
  })()
  return shutdownPromise
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.mrxuanz.codetask')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    // Thin shell: spawn/monitor Hono Service; do not import server/database/provider.
    // Service binds ephemeral (--port 0); ready handshake returns the real origin before UI loads.
    service = await startDesktopService({ smokeTest })
    if (smokeTest) {
      await runPackagedSmoke(service, gracefulShutdownFromApp)
      return
    }
    createWindow(service.url)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0 && service) createWindow(service.url)
    })
  } catch (error) {
    console.error(`[app] startup failed: ${error instanceof Error ? error.message : String(error)}`)
    await gracefulShutdownFromApp().catch((shutdownError) => {
      console.error(
        `[app] service shutdown after startup failure failed: ${
          shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
        }`
      )
    })
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('before-quit', async (event) => {
  if (!shutdownPromise) {
    event.preventDefault()
    await gracefulShutdownFromApp()
    app.quit()
  }
})
const handleShutdownSignal = createShutdownSignalHandler({
  shutdown: gracefulShutdownFromApp,
  exit: (code) => process.exit(code),
  log: (message, error) => console.error(message, error ?? '')
})
process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'))
process.on('SIGINT', () => handleShutdownSignal('SIGINT'))
