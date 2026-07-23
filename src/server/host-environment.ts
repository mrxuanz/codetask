import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'

export type HostEnvironmentSnapshot = Readonly<Record<string, string>>

export interface HostEnvironmentSource {
  snapshot(): HostEnvironmentSnapshot
}

const ENV_CAPTURE_START = '__CODETASK_HOST_ENV_START__'
const ENV_CAPTURE_END = '__CODETASK_HOST_ENV_END__'
const DEFAULT_PROBE_TIMEOUT_MS = 5_000
const MAX_ENV_OUTPUT_BYTES = 4 * 1024 * 1024

interface HostEnvironmentCommandOptions {
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
}

export type HostEnvironmentCommandRunner = (
  command: string,
  args: readonly string[],
  options: HostEnvironmentCommandOptions
) => Promise<string>

export interface ResolveHostEnvironmentOptions {
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  readonly platform?: NodeJS.Platform | undefined
  readonly userShell?: string | undefined
  readonly timeoutMs?: number | undefined
  readonly runCommand?: HostEnvironmentCommandRunner | undefined
}

function snapshotEnvironment(
  env: Readonly<Record<string, string | undefined>>
): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') snapshot[key] = value
  }
  return snapshot
}

const runEnvironmentCommand: HostEnvironmentCommandRunner = (command, args, { env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: 'utf8',
        env,
        timeout: timeoutMs,
        maxBuffer: MAX_ENV_OUTPUT_BYTES,
        windowsHide: true
      },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(stdout)
      }
    )
  })

function parseCapturedJsonEnvironment(output: string): Record<string, string> | null {
  const start = output.indexOf(ENV_CAPTURE_START)
  if (start === -1) return null
  const valueStart = start + ENV_CAPTURE_START.length
  const end = output.indexOf(ENV_CAPTURE_END, valueStart)
  if (end === -1) return null

  try {
    const value = JSON.parse(output.slice(valueStart, end)) as unknown
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    return snapshotEnvironment(value as Record<string, string | undefined>)
  } catch {
    return null
  }
}

function parseCapturedNullEnvironment(output: string): Record<string, string> | null {
  const fields = output.split('\0')
  const start = fields.indexOf(ENV_CAPTURE_START)
  if (start === -1) return null
  const end = fields.indexOf(ENV_CAPTURE_END, start + 1)
  if (end === -1) return null

  const captured: Record<string, string> = {}
  for (const field of fields.slice(start + 1, end)) {
    const separator = field.indexOf('=')
    if (separator <= 0) continue
    captured[field.slice(0, separator)] = field.slice(separator + 1)
  }
  return captured
}

function posixQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function posixShellCandidates(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string>>,
  userShell?: string
): string[] {
  let systemShell = userShell?.trim()
  if (!systemShell) {
    try {
      systemShell = userInfo().shell?.trim()
    } catch {
      systemShell = undefined
    }
  }
  const fallback = platform === 'darwin' ? '/bin/zsh' : '/bin/bash'
  return [...new Set([env.SHELL?.trim(), systemShell, fallback].filter(Boolean) as string[])]
}

async function capturePosixEnvironment(input: {
  readonly env: Record<string, string>
  readonly platform: NodeJS.Platform
  readonly userShell?: string | undefined
  readonly timeoutMs: number
  readonly runCommand: HostEnvironmentCommandRunner
}): Promise<Record<string, string> | null> {
  const command = [
    `printf '\\0%s\\0' ${posixQuote(ENV_CAPTURE_START)}`,
    'command env -0',
    `printf '%s\\0' ${posixQuote(ENV_CAPTURE_END)}`
  ].join('; ')
  const deadline = Date.now() + input.timeoutMs

  for (const shell of posixShellCandidates(input.platform, input.env, input.userShell)) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      const output = await input.runCommand(shell, ['-ilc', command], {
        env: input.env,
        timeoutMs: remainingMs
      })
      const captured = parseCapturedNullEnvironment(output)
      if (captured) return captured
    } catch {
      // A broken or unsupported login shell must not prevent runtime startup.
    }
  }
  return null
}

async function captureWindowsEnvironment(input: {
  readonly env: Record<string, string>
  readonly timeoutMs: number
  readonly runCommand: HostEnvironmentCommandRunner
}): Promise<Record<string, string> | null> {
  const script = [
    '$values = @{}',
    'Get-ChildItem Env: | ForEach-Object { $values[$_.Name] = [string]$_.Value }',
    `[Console]::Out.Write('${ENV_CAPTURE_START}')`,
    '[Console]::Out.Write(($values | ConvertTo-Json -Compress))',
    `[Console]::Out.Write('${ENV_CAPTURE_END}')`
  ].join('; ')
  const deadline = Date.now() + input.timeoutMs

  for (const shell of ['pwsh.exe', 'powershell.exe']) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    try {
      const output = await input.runCommand(
        shell,
        ['-NoLogo', '-NonInteractive', '-Command', script],
        {
          env: input.env,
          timeoutMs: remainingMs
        }
      )
      const captured = parseCapturedJsonEnvironment(output)
      if (captured) return captured
    } catch {
      // PowerShell is optional; inherited Windows environment remains valid fallback.
    }
  }
  return null
}

function readPath(
  env: Readonly<Record<string, string>>,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return env.PATH
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === 'path')
  return key ? env[key] : undefined
}

function mergePathValues(
  preferred: string | undefined,
  inherited: string | undefined,
  platform: NodeJS.Platform
): string | undefined {
  const separator = platform === 'win32' ? ';' : ':'
  const seen = new Set<string>()
  const entries: string[] = []
  for (const value of [preferred, inherited]) {
    for (const rawEntry of value?.split(separator) ?? []) {
      const entry = rawEntry.trim()
      if (!entry) continue
      const key = platform === 'win32' ? entry.toLowerCase() : entry
      if (seen.has(key)) continue
      seen.add(key)
      entries.push(entry)
    }
  }
  return entries.length > 0 ? entries.join(separator) : undefined
}

function mergeEnvironments(
  shellEnvironment: Readonly<Record<string, string>>,
  inheritedEnvironment: Readonly<Record<string, string>>,
  platform: NodeJS.Platform
): Record<string, string> {
  const merged: Record<string, string> = {}
  const setValue = (key: string, value: string): void => {
    if (platform === 'win32') {
      const duplicate = Object.keys(merged).find(
        (candidate) => candidate.toLowerCase() === key.toLowerCase()
      )
      if (duplicate) delete merged[duplicate]
    }
    merged[key] = value
  }

  for (const [key, value] of Object.entries(shellEnvironment)) setValue(key, value)
  for (const [key, value] of Object.entries(inheritedEnvironment)) setValue(key, value)

  const path = mergePathValues(
    readPath(shellEnvironment, platform),
    readPath(inheritedEnvironment, platform),
    platform
  )
  if (platform === 'win32') {
    for (const key of Object.keys(merged)) {
      if (key.toLowerCase() === 'path') delete merged[key]
    }
  }
  if (path) merged.PATH = path

  // Probe-only runtime control must never leak into Provider child environments.
  if (!Object.prototype.hasOwnProperty.call(inheritedEnvironment, 'ELECTRON_RUN_AS_NODE')) {
    delete merged.ELECTRON_RUN_AS_NODE
  }
  return merged
}

/**
 * Resolve the user's effective command environment without knowing anything
 * about Node version managers. Login-shell state fills missing values and takes
 * PATH precedence; the inherited process environment remains authoritative for
 * explicit application/auth overrides.
 */
export async function resolveHostEnvironment(
  options: ResolveHostEnvironmentOptions = {}
): Promise<HostEnvironmentSnapshot> {
  const inherited = snapshotEnvironment(options.env ?? process.env)
  const platform = options.platform ?? process.platform
  const runCommand = options.runCommand ?? runEnvironmentCommand
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS

  const captured =
    platform === 'darwin' || platform === 'linux'
      ? await capturePosixEnvironment({
          env: inherited,
          platform,
          userShell: options.userShell,
          timeoutMs,
          runCommand
        })
      : platform === 'win32'
        ? await captureWindowsEnvironment({ env: inherited, timeoutMs, runCommand })
        : null

  return Object.freeze(captured ? mergeEnvironments(captured, inherited, platform) : inherited)
}

export class ProcessHostEnvironmentSource implements HostEnvironmentSource {
  private installedSnapshot: HostEnvironmentSnapshot | null = null

  install(snapshot: HostEnvironmentSnapshot): void {
    this.installedSnapshot = Object.freeze({ ...snapshot })
  }

  snapshot(): HostEnvironmentSnapshot {
    return this.installedSnapshot ?? Object.freeze(snapshotEnvironment(process.env))
  }
}

export const processHostEnvironmentSource = new ProcessHostEnvironmentSource()

let initialization: Promise<HostEnvironmentSnapshot> | null = null

/** Resolve and freeze host shell state once before Provider discovery begins. */
export function initializeProcessHostEnvironment(): Promise<HostEnvironmentSnapshot> {
  initialization ??= resolveHostEnvironment().then((snapshot) => {
    processHostEnvironmentSource.install(snapshot)
    return snapshot
  })
  return initialization
}

/** Redacted presence of a host auth-related environment key — never the value. */
export interface HostAuthKeyPresence {
  readonly key: string
  readonly present: boolean
}

/**
 * Host auth inspection boundary.
 * Returns only whether controlled materials appear present — never secret values.
 */
export interface HostAuthSource {
  inspectEnvironmentKeys(keys: readonly string[]): readonly HostAuthKeyPresence[]
}

export class ProcessHostAuthSource implements HostAuthSource {
  constructor(private readonly envSource: HostEnvironmentSource = processHostEnvironmentSource) {}

  inspectEnvironmentKeys(keys: readonly string[]): readonly HostAuthKeyPresence[] {
    const snapshot = this.envSource.snapshot()
    return keys.map((key) => ({
      key,
      present: Boolean(snapshot[key]?.trim())
    }))
  }
}

export const processHostAuthSource: HostAuthSource = new ProcessHostAuthSource()
