import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseCliArgs } from './cli'
import { startAppServer, gracefulShutdown, type ServerInfo } from './server'
import { SafeLoggerImpl } from '../server/application/safe-logger'
import { resolveDataDirSelection } from './data-dir'
import { discoverRunningService } from './service-discovery'
import { createElectronServerPlatform } from './electron-server-platform'
import { createShutdownSignalHandler } from './shutdown-signal'

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:'])

let logDir: string | undefined
try {
  logDir = join(app.getPath('userData'), 'logs')
} catch {
  logDir = undefined
}
const earlyLogger = new SafeLoggerImpl(logDir ? { logDir } : undefined)
earlyLogger.info('SafeLogger installed on main process')

const cli = parseCliArgs()
if (cli.mode === 'server') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('disable-gpu')
  app.commandLine.appendSwitch('disable-gpu-compositing')
}

let serverInfo: ServerInfo | null = null

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
  shutdownPromise ??= gracefulShutdown()
  return shutdownPromise
}

async function runPackagedSmoke(server: ServerInfo): Promise<void> {
  const response = await fetch(`${server.url}/api/health`, {
    signal: AbortSignal.timeout(15_000)
  })
  if (!response.ok) {
    throw new Error(`Smoke health check failed with HTTP ${response.status}`)
  }

  const body = (await response.json()) as { success?: boolean; data?: { status?: string } }
  if (body.success !== true || body.data?.status !== 'ok') {
    throw new Error('Smoke health check returned an unexpected response')
  }

  console.log(`CODETASK_SMOKE_READY ${JSON.stringify({ url: server.url, health: 'ok' })}`)
  await gracefulShutdownFromApp()
  app.exit(0)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    if (cli.mode === 'desktop') {
      const storage = resolveDataDirSelection({ explicitDataDir: cli.dataDir, mode: cli.mode })
      serverInfo = await discoverRunningService(
        storage.bootstrap,
        storage.phase === 'ready' ? storage.dataDir : undefined
      )
      if (serverInfo) {
        console.log(`[desktop] using running service at ${serverInfo.url}`)
      }
    }
    serverInfo ??= await startAppServer(cli, createElectronServerPlatform())
    ipcMain.handle('get-server-info', () => serverInfo)
    ipcMain.handle('select-data-directory', async () => {
      const owner = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const result = owner
        ? await dialog.showOpenDialog(owner, {
            title: 'Choose CodeTask data directory',
            properties: ['openDirectory', 'createDirectory']
          })
        : await dialog.showOpenDialog({
            title: 'Choose CodeTask data directory',
            properties: ['openDirectory', 'createDirectory']
          })
      return result.canceled ? null : (result.filePaths[0] ?? null)
    })
    ipcMain.handle('relaunch-app', async () => {
      await gracefulShutdownFromApp()
      app.relaunch()
      app.exit(0)
    })
    if (cli.smokeTest) {
      await runPackagedSmoke(serverInfo)
      return
    }
    if (cli.mode === 'desktop') {
      createWindow(serverInfo.url)
      app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0 && serverInfo) createWindow(serverInfo.url)
      })
    } else {
      console.log(`[server] headless  open in browser: ${serverInfo.url}`)
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
