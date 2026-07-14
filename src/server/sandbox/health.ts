import { existsSync } from 'fs'
import { spawnSync } from 'child_process'
import { SandboxError } from './types'
import type { SandboxBackend, SandboxBootstrapInfo } from './types'
import { isOuterSandboxEnabled } from './orchestrator-local'
import { getSandboxSupervisorManager } from './supervisor-manager'
import { tryLoadSandboxNative } from './native'
import { fixedSandboxHome, sandboxSetupIsComplete } from './windows-bootstrap'

export type SandboxHealthStatus = 'ready' | 'degraded' | 'unavailable' | 'disabled'

export interface SandboxHealthCheck {
  ok: boolean
  code?: string | undefined
  message?: string | undefined
  requirement?: string | undefined
}

export interface SandboxHealthReport {
  status: SandboxHealthStatus
  platform: NodeJS.Platform
  outerSandboxEnabled: boolean
  backend?: SandboxBackend | undefined
  native: SandboxHealthCheck
  platformRuntime?: SandboxHealthCheck | undefined
  windowsSetup?: SandboxHealthCheck | undefined
  supervisor?: SandboxHealthCheck | undefined
  helperVersion?: string | undefined
  warnings: string[]
}

function checkNative(): SandboxHealthCheck & { helperVersion?: string | undefined } {
  const native = tryLoadSandboxNative()
  if (!native) {
    return {
      ok: false,
      code: 'sandbox.native.missing',
      message: 'Native sandbox module not found; run `npm run build:sandbox`'
    }
  }
  const helperVersion = native.helperVersion()
  try {
    native.preflight()
    return { ok: true, helperVersion }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof SandboxError) {
      return {
        ok: false,
        code: error.code,
        message,
        requirement: error.requirement,
        helperVersion
      }
    }
    return { ok: false, code: 'sandbox.native.preflight_failed', message, helperVersion }
  }
}

function checkPlatformRuntime(): SandboxHealthCheck {
  if (process.platform === 'linux') {
    const bwrap = spawnSync('which', ['bwrap'], { encoding: 'utf8' })
    if (bwrap.status !== 0) {
      return {
        ok: false,
        code: 'sandbox.preflight.bwrap_missing',
        message: 'Linux sandbox requires bubblewrap (bwrap)',
        requirement: 'bwrap'
      }
    }
    return { ok: true }
  }

  if (process.platform === 'darwin') {
    if (!existsSync('/usr/bin/sandbox-exec')) {
      return {
        ok: false,
        code: 'sandbox.preflight.seatbelt_missing',
        message: 'macOS sandbox requires /usr/bin/sandbox-exec',
        requirement: 'sandbox-exec'
      }
    }
    return { ok: true }
  }

  return { ok: true }
}

function checkWindowsSetup(dataDir?: string): SandboxHealthCheck {
  if (process.platform !== 'win32') return { ok: true }

  try {
    const native = tryLoadSandboxNative()
    if (!native) {
      return {
        ok: false,
        code: 'sandbox.native.missing',
        message: 'Native sandbox module not found'
      }
    }
    const sandboxHome = fixedSandboxHome(dataDir ?? process.cwd())
    const ready = native.windowsSetupStatus(sandboxHome) || sandboxSetupIsComplete(sandboxHome)
    if (!ready) {
      return {
        ok: false,
        code: 'sandbox.windows.setup_incomplete',
        message:
          'Windows sandbox setup incomplete; UAC setup will be attempted when running a task',
        requirement: 'windows-setup'
      }
    }
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, code: 'sandbox.windows.setup_check_failed', message }
  }
}

function checkSupervisor(): SandboxHealthCheck {
  if (process.env.CODETASK_SANDBOX_SUPERVISOR === '0') {
    return { ok: true, message: 'supervisor disabled (direct native path)' }
  }
  const manager = getSandboxSupervisorManager()
  const snapshot = manager.statusSnapshot()
  if (snapshot.ready) return { ok: true }
  if (snapshot.starting) {
    return { ok: false, code: 'sandbox.supervisor.starting', message: 'supervisor is starting' }
  }
  if (snapshot.lastError) {
    return {
      ok: false,
      code: 'sandbox.supervisor.unavailable',
      message: snapshot.lastError
    }
  }
  return {
    ok: false,
    code: 'sandbox.supervisor.not_started',
    message: 'supervisor has not started; it will launch on demand on first task'
  }
}

function resolveBackend(): SandboxBackend | undefined {
  if (process.platform === 'linux') return 'linux-bwrap-seccomp'
  if (process.platform === 'darwin') return 'macos-seatbelt'
  if (process.platform === 'win32') return 'windows-elevated'
  return undefined
}

export function getSandboxHealth(dataDir?: string): SandboxHealthReport {
  const outerSandboxEnabled = isOuterSandboxEnabled()
  if (!outerSandboxEnabled) {
    return {
      status: 'disabled',
      platform: process.platform,
      outerSandboxEnabled: false,
      native: { ok: true, message: 'CODETASK_DISABLE_OUTER_SANDBOX=1 (desktop only)' },
      warnings: ['Outer sandbox is disabled; file-role execution will be rejected']
    }
  }

  const native = checkNative()
  const platformRuntime = checkPlatformRuntime()
  const windowsSetup = checkWindowsSetup(dataDir)
  const supervisor = checkSupervisor()
  const warnings: string[] = []

  const critical = [native, platformRuntime, windowsSetup]
  const allReady = critical.every((c) => c.ok) && supervisor.ok

  if (!native.ok) warnings.push(native.message ?? 'native unavailable')
  if (!platformRuntime.ok) warnings.push(platformRuntime.message ?? 'platform runtime missing')
  if (!windowsSetup.ok && process.platform === 'win32') {
    warnings.push(windowsSetup.message ?? 'Windows setup incomplete')
  }
  if (!supervisor.ok) warnings.push(supervisor.message ?? 'supervisor not ready')

  let status: SandboxHealthStatus = 'ready'
  if (!native.ok || !platformRuntime.ok) {
    status = 'unavailable'
  } else if (!allReady) {
    status = 'degraded'
  }

  return {
    status,
    platform: process.platform,
    outerSandboxEnabled,
    backend: resolveBackend(),
    native,
    platformRuntime,
    windowsSetup: process.platform === 'win32' ? windowsSetup : undefined,
    supervisor,
    helperVersion: native.helperVersion,
    warnings
  }
}

export function assertSandboxReadyForExecution(dataDir?: string): void {
  const health = getSandboxHealth(dataDir)
  if (health.status === 'disabled') {
    throw new SandboxError('Outer sandbox is disabled', 'sandbox.required')
  }
  if (!health.native.ok) {
    throw new SandboxError(
      health.native.message ?? 'native sandbox unavailable',
      health.native.code ?? 'sandbox.native.missing',
      health.native.requirement
    )
  }
  if (health.platformRuntime && !health.platformRuntime.ok) {
    throw new SandboxError(
      health.platformRuntime.message ?? 'platform sandbox runtime missing',
      health.platformRuntime.code ?? 'sandbox.platform.missing',
      health.platformRuntime.requirement
    )
  }
}

export function sandboxBootstrapInfo(dataDir?: string): SandboxBootstrapInfo {
  const health = getSandboxHealth(dataDir)
  if (process.platform !== 'win32') {
    return {
      required: false,
      ready: health.status === 'ready' || health.status === 'degraded',
      platform: process.platform,
      backend: health.backend,
      error: health.status === 'unavailable' ? health.warnings.join('; ') : undefined
    }
  }
  return {
    required: true,
    ready: health.windowsSetup?.ok ?? false,
    platform: process.platform,
    backend: health.backend,
    error: health.windowsSetup?.ok ? undefined : health.windowsSetup?.message
  }
}
