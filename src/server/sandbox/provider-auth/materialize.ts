import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'
import { chmodSync } from 'fs'
import { dirname, join } from 'path'
import {
  cursorProjectSlug,
  resolveCodexHostAuthPath,
  resolveCodexHostConfigPath,
  resolveCursorHostAuthPath,
  resolveCursorHostConfigDir,
  resolveCursorHostCursorHome,
  resolveHostProfilePaths,
  resolveOpencodeHostConfigDir,
  resolveOpencodeHostDataDir,
  runtimeCodexHome,
  runtimeCursorAuthPath,
  runtimeCursorConfigDir,
  runtimeCursorHome
} from './paths'

const CODEX_TOP_LEVEL_ALLOW_KEYS = new Set([
  'model',
  'model_provider',
  'provider',
  'default_model',
  'preferred_model',
  'temperature',
  'reasoning_effort',
  'model_reasoning_effort',
  'model_verbosity',
  'sandbox_mode',
  'network_access',
  'approval_policy'
])

const CODEX_DROP_SECTION_PREFIXES = [
  'mcp',
  'mcp_servers',
  'projects',
  'project',
  'plugin',
  'plugins',
  'workspace',
  'trust',
  'telemetry',
  'analytics',
  'hooks',
  'tui',
  'windows'
]

function shouldKeepCodexSection(section: string): boolean {
  const lower = section.toLowerCase()
  if (lower === 'model_providers' || lower.startsWith('model_providers.')) return true
  return !CODEX_DROP_SECTION_PREFIXES.some(
    (prefix) => lower === prefix || lower.startsWith(`${prefix}.`)
  )
}

function restrictFilePermissions(path: string): void {
  if (process.platform === 'win32') return
  try {
    chmodSync(path, 0o600)
  } catch {
    // ignore
  }
}

function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
}

export function copyAuthSnapshot(source: string, destination: string): void {
  ensureParentDir(destination)
  copyFileSync(source, destination)
  restrictFilePermissions(destination)
}

export function filterCodexConfigToml(raw: string): string {
  const lines = raw.split(/\r?\n/)
  const kept: string[] = []
  let skipSection = false
  let currentSection = ''

  for (const line of lines) {
    const trimmed = line.trim()
    const sectionMatch = trimmed.match(/^\[([^\]]+)\]$/)
    if (sectionMatch) {
      const section = (sectionMatch[1] ?? '').toLowerCase()
      currentSection = section
      skipSection = !shouldKeepCodexSection(section)
      if (!skipSection) kept.push(line)
      continue
    }

    if (skipSection) continue

    const inSection = currentSection !== ''
    if (inSection && currentSection.startsWith('model_providers')) {
      kept.push(line)
      continue
    }

    const keyMatch = trimmed.match(/^([A-Za-z0-9_.-]+)\s*=/)
    if (!inSection && keyMatch) {
      const key = (keyMatch[1] ?? '').toLowerCase()
      if (CODEX_TOP_LEVEL_ALLOW_KEYS.has(key) || key.endsWith('_url') || key.includes('model')) {
        kept.push(line)
      }
      continue
    }

    if (trimmed.startsWith('#') || trimmed === '') {
      kept.push(line)
    }
  }

  return `${kept.join('\n').trim()}\n`
}

export interface MaterializeCodexResult {
  authCopied: boolean
  configCopied: boolean
  runtimeAuthPath: string
  hostAuthPath: string
  cleanup: () => void
}

export function materializeCodexAuth(runtimeRoot: string): MaterializeCodexResult {
  const hostAuthPath = resolveCodexHostAuthPath()
  const codexHome = runtimeCodexHome(runtimeRoot)
  const runtimeAuthPath = join(codexHome, 'auth.json')

  if (existsSync(codexHome)) {
    try {
      rmSync(codexHome, { recursive: true, force: true })
    } catch {
      // ignore
    }
  }
  mkdirSync(codexHome, { recursive: true })

  const cleanupPaths: string[] = []
  let authCopied = false
  let configCopied = false

  if (existsSync(hostAuthPath)) {
    copyAuthSnapshot(hostAuthPath, runtimeAuthPath)
    authCopied = true
    cleanupPaths.push(runtimeAuthPath)
  }

  const hostConfigPath = resolveCodexHostConfigPath()
  const runtimeConfigPath = join(codexHome, 'config.toml')

  if (existsSync(hostConfigPath)) {
    const filtered = filterCodexConfigToml(readFileSync(hostConfigPath, 'utf8'))
    writeFileSync(runtimeConfigPath, filtered, 'utf8')
    restrictFilePermissions(runtimeConfigPath)
    configCopied = true
    cleanupPaths.push(runtimeConfigPath)
  }

  return {
    authCopied,
    configCopied,
    runtimeAuthPath,
    hostAuthPath,
    cleanup: () => {
      for (const path of cleanupPaths) {
        try {
          if (existsSync(path)) unlinkSync(path)
        } catch {
          // ignore
        }
      }
    }
  }
}

export interface MaterializeCursorResult {
  authCopied: boolean
  runtimeAuthPath: string
  hostAuthPath: string
  cleanup: () => void
}

export function materializeCursorAuth(
  runtimeRoot: string,
  workspaceRoot: string
): MaterializeCursorResult {
  const hostAuthPath = resolveCursorHostAuthPath()
  const runtimeAuthPath = runtimeCursorAuthPath(runtimeRoot)
  const profile = resolveHostProfilePaths()
  const hostCursorHome = resolveCursorHostCursorHome(profile)
  const hostConfigDir = resolveCursorHostConfigDir(profile)

  const cursorHome = runtimeCursorHome(runtimeRoot)
  const cursorConfig = runtimeCursorConfigDir(runtimeRoot)
  const projectDir = join(cursorHome, 'projects', cursorProjectSlug(workspaceRoot))

  for (const stale of [cursorHome, cursorConfig, dirname(runtimeAuthPath)]) {
    if (existsSync(stale)) {
      try {
        rmSync(stale, { recursive: true, force: true })
      } catch {
        // ignore
      }
    }
  }

  mkdirSync(cursorHome, { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(join(projectDir, 'agent-transcripts'), { recursive: true })
  mkdirSync(join(projectDir, 'terminals'), { recursive: true })
  writeFileSync(join(projectDir, 'worker.log'), '', { flag: 'a' })

  if (process.platform === 'win32') {
    mkdirSync(join(runtimeRoot, 'AppData', 'Roaming', 'Cursor'), { recursive: true })
    mkdirSync(join(runtimeRoot, 'AppData', 'Local'), { recursive: true })
  }

  mkdirSync(cursorConfig, { recursive: true })
  mkdirSync(join(cursorConfig, 'acp-sessions'), { recursive: true })
  mkdirSync(dirname(runtimeAuthPath), { recursive: true })

  const copiedPaths: string[] = []

  let authCopied = false
  if (existsSync(hostAuthPath)) {
    copyAuthSnapshot(hostAuthPath, runtimeAuthPath)
    authCopied = true
    copiedPaths.push(runtimeAuthPath)
  }

  const optionalCopies: Array<{ host: string; runtime: string }> = [
    { host: join(hostCursorHome, 'cli-config.json'), runtime: join(cursorHome, 'cli-config.json') },
    {
      host: join(hostCursorHome, 'agent-cli-state.json'),
      runtime: join(cursorHome, 'agent-cli-state.json')
    },
    {
      host: join(hostConfigDir, 'cli-config.json'),
      runtime: join(cursorConfig, 'cli-config.json')
    },
    { host: join(hostConfigDir, 'acp-config.json'), runtime: join(cursorConfig, 'acp-config.json') }
  ]

  for (const { host, runtime } of optionalCopies) {
    if (!existsSync(host)) continue
    copyAuthSnapshot(host, runtime)
    copiedPaths.push(runtime)
  }

  return {
    authCopied,
    runtimeAuthPath,
    hostAuthPath,
    cleanup: () => {
      for (const path of copiedPaths) {
        try {
          if (existsSync(path)) unlinkSync(path)
        } catch {
          // ignore
        }
      }
    }
  }
}

export interface MaterializeOpencodeResult {
  configCopied: boolean
  runtimeConfigDir: string
  runtimeDataDir: string
  hostConfigDir: string
  cleanup: () => void
}

export function opencodeRuntimeLayout(runtimeRoot: string): {
  configHome: string
  dataHome: string
  stateHome: string
  configDir: string
  dataDir: string
} {
  return {
    configHome: join(runtimeRoot, '.config'),
    dataHome: join(runtimeRoot, '.local', 'share'),
    stateHome: join(runtimeRoot, '.local', 'state'),
    configDir: join(runtimeRoot, '.config', 'opencode'),
    dataDir: join(runtimeRoot, '.local', 'share', 'opencode')
  }
}

export function materializeOpencodeAuth(runtimeRoot: string): MaterializeOpencodeResult {
  const hostConfigDir = resolveOpencodeHostConfigDir()
  const hostDataDir = resolveOpencodeHostDataDir()
  const layout = opencodeRuntimeLayout(runtimeRoot)
  const { configDir: runtimeConfigDir, dataDir: runtimeDataDir } = layout

  mkdirSync(runtimeConfigDir, { recursive: true })
  mkdirSync(runtimeDataDir, { recursive: true })

  const copied: string[] = []
  const configCandidates = ['opencode.json', 'auth.json', 'config.json', 'credentials.json']
  const dataCandidates = ['auth.json', 'credentials.json']

  for (const name of configCandidates) {
    const source = join(hostConfigDir, name)
    if (!existsSync(source)) continue
    const dest = join(runtimeConfigDir, name)
    copyAuthSnapshot(source, dest)
    copied.push(dest)
  }

  for (const name of dataCandidates) {
    const source = join(hostDataDir, name)
    if (!existsSync(source)) continue
    const dest = join(runtimeDataDir, name)
    copyAuthSnapshot(source, dest)
    copied.push(dest)
  }

  return {
    configCopied: copied.length > 0,
    runtimeConfigDir,
    runtimeDataDir,
    hostConfigDir,
    cleanup: () => {
      for (const path of copied) {
        try {
          if (existsSync(path)) unlinkSync(path)
        } catch {
          // ignore
        }
      }
    }
  }
}
