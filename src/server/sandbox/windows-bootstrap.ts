import { existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { SandboxError } from './types'
import { loadSandboxNative, resolveRunnerEntryScript, resolveSetupEntryScript } from './native'

let initPromise: Promise<void> | null = null

export function fixedSandboxHome(dataDir: string): string {
  if (process.env.CODETASK_SANDBOX_HOME?.trim()) {
    return process.env.CODETASK_SANDBOX_HOME.trim()
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA
    if (localAppData) {
      return join(localAppData, 'codetask', 'sandbox-home')
    }
  }
  return join(dataDir, 'sandbox-home')
}

export function sandboxSetupIsComplete(sandboxHome: string): boolean {
  const marker = join(sandboxHome, 'sandbox', 'setup_marker.json')
  const users = join(sandboxHome, 'sandbox', 'sandbox_users.json')
  return existsSync(marker) && existsSync(users)
}

export async function ensureWindowsSandboxReady(dataDir: string): Promise<void> {
  if (process.platform !== 'win32') return

  if (initPromise) {
    await initPromise
    return
  }

  initPromise = (async () => {
    const sandboxHome = fixedSandboxHome(dataDir)
    mkdirSync(join(sandboxHome, 'sandbox'), { recursive: true })

    const native = loadSandboxNative()

    try {
      native.windowsSetup(
        process.execPath,
        resolveSetupEntryScript(),
        resolveRunnerEntryScript(),
        sandboxHome,
        process.cwd()
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new SandboxError(
        `Windows 沙箱 UAC setup 失败: ${message}`,
        'sandbox.windows.setup_failed'
      )
    }

    if (native.windowsSetupStatus(sandboxHome)) {
      console.log('[sandbox] Windows sandbox ready')
      return
    }

    throw new SandboxError(
      'Windows 沙箱 setup 完成但 marker 未就绪',
      'sandbox.windows.setup_incomplete'
    )
  })()

  await initPromise
}

export function resetWindowsSandboxInitForTests(): void {
  initPromise = null
}
