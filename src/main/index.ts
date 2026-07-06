import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { parseCliArgs } from './cli'
import { startAppServer, stopAppServer, type ServerInfo } from './server'

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

app.on('before-quit', () => {
  stopAppServer()
})
