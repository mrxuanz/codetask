import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseCliArgs } from './cli'
import { startAppServer, stopAppServer, type ServerInfo } from './server'
import { SafeLoggerImpl } from '../server/application/safe-logger'

// Install stream EIO/EPIPE fail-closed logging before any other console use.
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

function createWindow(serverUrl: string): void {
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  mainWindow.loadURL(serverUrl)
}

let shuttingDown = false

async function gracefulShutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  console.log('[app] graceful shutdown initiated')
  await stopAppServer()
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  try {
    serverInfo = await startAppServer(cli)

    ipcMain.handle('get-server-info', () => serverInfo)

    if (cli.mode === 'desktop') {
      createWindow(serverInfo.url)

      app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0 && serverInfo) {
          createWindow(serverInfo.url)
        }
      })
    } else {
      console.log(`[server] headless  open in browser: ${serverInfo.url}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[app] startup failed: ${message}`)
    app.exit(1)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', async (event) => {
  if (!shuttingDown) {
    event.preventDefault()
    await gracefulShutdown()
    app.quit()
  }
})

process.on('SIGTERM', () => {
  void gracefulShutdown().finally(() => process.exit(0))
})

process.on('SIGINT', () => {
  void gracefulShutdown().finally(() => process.exit(0))
})
