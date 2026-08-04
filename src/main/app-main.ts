import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseCliArgs } from './cli'
import { createShutdownSignalHandler } from './shutdown-signal'
import { startDesktopService, type DesktopServiceHandle } from './desktop-service'

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

const cli = parseCliArgs()
if (cli.mode === 'server') {
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
      preload: join(__dirname, '../preload/index.js'),
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

async function runPackagedSmoke(handle: DesktopServiceHandle): Promise<void> {
  const response = await fetch(`${handle.url}/api/health`, {
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`Smoke health check failed with HTTP ${response.status}`)
  }

  const body = (await response.json()) as { success?: boolean; data?: { status?: string } }
  if (body.success !== true || body.data?.status !== 'ok') {
    throw new Error('Smoke health check returned an unexpected response')
  }

  console.log(
    `CODETASK_SMOKE_READY ${JSON.stringify({ url: handle.url, health: 'ok', instanceId: handle.instanceId })}`
  )
  await gracefulShutdownFromApp()
  app.exit(0)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    // Thin shell: spawn/monitor Hono Service; do not import server/database/provider.
    service = await startDesktopService()
    ipcMain.handle('get-server-info', () =>
      service
        ? {
            host: '127.0.0.1',
            port: service.port,
            url: service.url,
            requestedPort: 0,
            portChanged: true,
            mode: cli.mode
          }
        : null
    )
    if (cli.smokeTest) {
      await runPackagedSmoke(service)
      return
    }
    if (cli.mode === 'desktop') {
      createWindow(service.url)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && service) createWindow(service.url)
      })
    } else {
      console.log(`[server] headless open in browser: ${service.url}`)
    }
  } catch (error) {
    console.error(`[app] startup failed: ${error instanceof Error ? error.message : String(error)}`)
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
