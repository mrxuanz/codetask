import { execFileSync } from 'child_process'
import { dirname, normalize, parse, sep } from 'path'
import { existsSync, realpathSync, statSync } from 'fs'
import type { SupportedCoreCode } from '../conversation/cores'
import {
  resolveCursorAgentInstallDirs,
  resolveCodexInstallDirs,
  resolveClaudeInstallDirs,
  resolveOpencodeInstallDirs
} from './provider-auth/paths'

const PROVIDER_COMMANDS: Record<SupportedCoreCode, string[]> = {
  codex: ['codex'],
  'claude-code': ['claude', 'claude-code'],
  opencode: ['opencode'],
  cursorcli: ['agent', 'cursor-agent', 'cursor']
}

const RUNTIME_COMMANDS = ['node']
const TOOL_HOME_ENV_KEYS = ['VOLTA_HOME', 'NVM_SYMLINK'] as const

function whereCommand(command: string): string[] {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync('where', [command], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      return output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    } catch {
      return []
    }
  }

  try {
    const output = execFileSync('which', [command], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const line = output.trim()
    return line ? [line] : []
  } catch {
    return []
  }
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return normalize(path)
    }
  }
}

function existingDirectoryFor(path: string): string | null {
  const clean = path.trim().replace(/^"|"$/g, '')
  if (!clean || !existsSync(clean)) return null
  try {
    const stat = statSync(clean)
    return normalize(stat.isDirectory() ? clean : dirname(clean))
  } catch {
    return null
  }
}

function ancestorNamed(path: string, segment: string): string | null {
  const normalized = normalize(path)
  const parsed = parse(normalized)
  const parts = normalized
    .slice(parsed.root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  const index = parts.findIndex((part) => part.toLowerCase() === segment.toLowerCase())
  if (index === -1) return null
  return safeRealpath(`${parsed.root}${parts.slice(0, index + 1).join(sep)}`)
}

function isSafeReadRoot(path: string): boolean {
  const normalized = normalize(path)
  const root = parse(normalized).root
  return normalized.toLowerCase() !== root.toLowerCase()
}

function addRoot(roots: Map<string, string>, path: string | null | undefined): void {
  if (!path || !existsSync(path) || !isSafeReadRoot(path)) return
  const normalized = normalize(path)
  roots.set(normalized.toLowerCase(), normalized)

  const real = safeRealpath(normalized)
  if (isSafeReadRoot(real)) {
    roots.set(real.toLowerCase(), real)
  }
  if (real.toLowerCase() !== normalized.toLowerCase()) {
    const parent = dirname(normalized)
    if (isSafeReadRoot(parent)) {
      roots.set(parent.toLowerCase(), parent)
    }
  }
}

export function resolveProviderReadRoots(provider: SupportedCoreCode): string[] {
  const roots = new Map<string, string>()
  const commands = [...PROVIDER_COMMANDS[provider], ...RUNTIME_COMMANDS]

  for (const command of commands) {
    for (const candidate of whereCommand(command)) {
      const dir = existingDirectoryFor(candidate)
      addRoot(roots, dir)
      addRoot(roots, dir ? ancestorNamed(dir, 'Volta') : null)
    }
  }

  for (const key of TOOL_HOME_ENV_KEYS) {
    addRoot(roots, process.env[key])
  }

  if (provider === 'cursorcli') {
    for (const dir of resolveCursorAgentInstallDirs()) {
      addRoot(roots, dir)
    }
  }

  if (provider === 'codex') {
    for (const dir of resolveCodexInstallDirs()) {
      addRoot(roots, dir)
    }
  }

  if (provider === 'claude-code') {
    for (const dir of resolveClaudeInstallDirs()) {
      addRoot(roots, dir)
    }
  }

  if (provider === 'opencode') {
    for (const dir of resolveOpencodeInstallDirs()) {
      addRoot(roots, dir)
    }
  }

  return [...roots.values()]
}

export function mergeProviderReadRoots(base: string[], extra: string[]): string[] {
  const roots = new Map<string, string>()
  for (const path of [...base, ...extra]) {
    addRoot(roots, path)
  }
  return [...roots.values()]
}
