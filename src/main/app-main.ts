import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { mkdirSync } from 'node:fs'
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
  async function json<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
    const response = await fetch(`${handle.url}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'x-codetask-auth-transport': 'bearer',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(15_000)
    })
    const body = (await response.json()) as {
      success?: boolean
      data?: T
      error?: { message?: string } | string
    }
    if (!response.ok || body.success !== true) {
      throw new Error(
        `Smoke ${path} failed with HTTP ${response.status}: ${JSON.stringify(body.error ?? body)}`
      )
    }
    return body.data as T
  }

  const health = await json<{ status: string }>('/api/health')
  if (health.status !== 'ok') throw new Error('Smoke health check returned an unexpected response')

  const credentials = { username: 'package-smoke', password: 'PackageSmoke-2026!Strong' }
  const setup = await json<{ token: string }>('/api/auth/setup', {
    method: 'POST',
    body: JSON.stringify(credentials)
  })
  await json('/api/auth/logout', { method: 'POST' }, setup.token)
  const login = await json<{ token: string }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(credentials)
  })

  const workspaceRoot = join(app.getPath('userData'), 'package-smoke-workspace')
  mkdirSync(workspaceRoot, { recursive: true })
  const project = await json<{ id: string }>(
    '/api/projects',
    {
      method: 'POST',
      body: JSON.stringify({
        title: 'Package smoke project',
        workspaceRoot,
        createIfMissing: true
      })
    },
    login.token
  )
  const conversation = await json<{ id: string }>(
    `/api/projects/${encodeURIComponent(project.id)}/conversations`,
    {
      method: 'POST',
      body: JSON.stringify({ title: 'Package smoke conversation', providerCode: 'codex' })
    },
    login.token
  )
  const turn = await json<{ turnId: string }>(
    `/api/conversations/${encodeURIComponent(conversation.id)}/turns`,
    {
      method: 'POST',
      body: JSON.stringify({
        message: 'Reply to the packaged smoke test.',
        attachmentIds: [],
        idempotencyKey: 'package-smoke-turn-1',
        providerCode: 'codex'
      })
    },
    login.token
  )

  let turnStatus = ''
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await json<{ state: string }>(
      `/api/conversations/${encodeURIComponent(conversation.id)}/turns/${encodeURIComponent(turn.turnId)}`,
      {},
      login.token
    )
    turnStatus = current.state
    if (turnStatus === 'completed') break
    if (turnStatus === 'failed' || turnStatus === 'cancelled') {
      throw new Error(`Packaged conversation smoke ended in ${turnStatus}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  if (turnStatus !== 'completed') throw new Error('Packaged conversation smoke timed out')

  const messages = await json<Array<{ role: string; content: string }>>(
    `/api/conversations/${encodeURIComponent(conversation.id)}/messages?limit=20`,
    {},
    login.token
  )
  if (
    !messages.some(
      (message) => message.role === 'assistant' && /smoke reply/i.test(message.content)
    )
  ) {
    throw new Error('Packaged conversation smoke did not persist the assistant reply')
  }

  console.log(
    `CODETASK_SMOKE_READY ${JSON.stringify({
      url: handle.url,
      health: 'ok',
      account: 'setup-login-ok',
      conversation: 'reply-ok',
      instanceId: handle.instanceId
    })}`
  )
  await gracefulShutdownFromApp()
  app.exit(0)
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('io.github.mrxuanz.codetask')
  app.on('browser-window-created', (_, window) => optimizer.watchWindowShortcuts(window))
  try {
    // Thin shell: spawn/monitor Hono Service; do not import server/database/provider.
    // Service binds ephemeral (--port 0); ready handshake returns the real origin before UI loads.
    service = await startDesktopService({ smokeTest: cli.smokeTest })
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
