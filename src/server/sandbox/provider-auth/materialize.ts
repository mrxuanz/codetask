import { spawnSync } from 'child_process'
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
  type HostProfilePaths,
  resolveOpencodeHostConfigDir,
  resolveOpencodeHostDataDir,
  runtimeCodexHome,
  runtimeCursorAuthPath,
  runtimeCursorConfigDir,
  runtimeCursorHome
} from './paths'
import {
  processHostEnvironmentSource,
  type HostEnvironmentSnapshot
} from '../../host-environment'
import {
  scrubCredentialSnapshotManifest,
  writeCredentialSnapshotManifest
} from './snapshot-manifest'

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

export function materializeCodexAuth(
  runtimeRoot: string,
  profile: HostProfilePaths = resolveHostProfilePaths()
): MaterializeCodexResult {
  const hostAuthPath = resolveCodexHostAuthPath(profile)
  const codexHome = runtimeCodexHome(runtimeRoot)
  const runtimeAuthPath = join(codexHome, 'auth.json')

  // Preserve existing CODEX_HOME contents across turns. Codex stores thread
  // rollouts under this directory; wiping it makes resumeThread fail with
  // "no rollout found for thread id" on the second message.
  mkdirSync(codexHome, { recursive: true })

  const cleanupPaths: string[] = []
  let authCopied = false
  let configCopied = false

  if (existsSync(hostAuthPath)) {
    copyAuthSnapshot(hostAuthPath, runtimeAuthPath)
    authCopied = true
    cleanupPaths.push(runtimeAuthPath)
  }

  const hostConfigPath = resolveCodexHostConfigPath(profile)
  const runtimeConfigPath = join(codexHome, 'config.toml')

  if (existsSync(hostConfigPath)) {
    const filtered = filterCodexConfigToml(readFileSync(hostConfigPath, 'utf8'))
    writeFileSync(runtimeConfigPath, filtered, 'utf8')
    restrictFilePermissions(runtimeConfigPath)
    configCopied = true
    cleanupPaths.push(runtimeConfigPath)
  }

  writeCredentialSnapshotManifest(runtimeRoot, 'codex', cleanupPaths)

  return {
    authCopied,
    configCopied,
    runtimeAuthPath,
    hostAuthPath,
    cleanup: () => {
      scrubCredentialSnapshotManifest(runtimeRoot)
    }
  }
}

export interface MaterializeCursorResult {
  authCopied: boolean
  runtimeAuthPath: string
  hostAuthPath: string
  cleanup: () => void
}

/** Darwin agent CLI reads `$HOME/.cursor/auth.json` when AGENT_CLI_CREDENTIAL_STORE=file. */
export function runtimeCursorCliAuthPath(runtimeRoot: string): string {
  return join(runtimeCursorHome(runtimeRoot), 'auth.json')
}

function writeCursorRuntimeAuthPayload(
  runtimeRoot: string,
  payload: Record<string, unknown>
): string[] {
  const raw = `${JSON.stringify(payload)}\n`
  const paths = [runtimeCursorCliAuthPath(runtimeRoot), runtimeCursorAuthPath(runtimeRoot)]
  const written: string[] = []
  for (const path of paths) {
    ensureParentDir(path)
    writeFileSync(path, raw, { encoding: 'utf8', mode: 0o600 })
    restrictFilePermissions(path)
    written.push(path)
  }
  return written
}

function mirrorCursorAuthFiles(source: string, runtimeRoot: string): string[] {
  const destinations = [runtimeCursorCliAuthPath(runtimeRoot), runtimeCursorAuthPath(runtimeRoot)]
  const written: string[] = []
  for (const destination of destinations) {
    if (destination === source) continue
    copyAuthSnapshot(source, destination)
    written.push(destination)
  }
  return written
}

function readDarwinCursorKeychainPassword(
  service: string,
  profile: HostProfilePaths,
  hostEnvironment: HostEnvironmentSnapshot
): string | null {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', service, '-a', 'cursor-user', '-w'],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...hostEnvironment,
        HOME: profile.home
      }
    }
  )
  if (result.status !== 0) return null
  const value = (result.stdout ?? '').trim()
  return value.length > 0 ? value : null
}

function readDarwinCursorKeychainTokens(
  profile: HostProfilePaths,
  hostEnvironment: HostEnvironmentSnapshot
): {
  accessToken: string
  refreshToken: string
} | null {
  if (process.platform !== 'darwin') return null
  const accessToken = readDarwinCursorKeychainPassword(
    'cursor-access-token',
    profile,
    hostEnvironment
  )
  const refreshToken = readDarwinCursorKeychainPassword(
    'cursor-refresh-token',
    profile,
    hostEnvironment
  )
  if (!accessToken || !refreshToken) return null
  return { accessToken, refreshToken }
}

/**
 * Ensure runtime has a file-store auth.json the Cursor CLI can read under HOME=runtimeRoot.
 * Prefer host auth.json, then macOS Keychain export (host HOME), then existing runtime copies.
 */
export function ensureCursorRuntimeAuth(
  runtimeRoot: string,
  profile: HostProfilePaths = resolveHostProfilePaths(),
  hostEnvironment: HostEnvironmentSnapshot = processHostEnvironmentSource.snapshot()
): boolean {
  const cliAuthPath = runtimeCursorCliAuthPath(runtimeRoot)
  const legacyAuthPath = runtimeCursorAuthPath(runtimeRoot)

  if (existsSync(cliAuthPath)) {
    if (!existsSync(legacyAuthPath)) copyAuthSnapshot(cliAuthPath, legacyAuthPath)
    return true
  }

  if (existsSync(legacyAuthPath)) {
    copyAuthSnapshot(legacyAuthPath, cliAuthPath)
    return true
  }

  const hostAuthPath = resolveCursorHostAuthPath(profile)
  if (existsSync(hostAuthPath)) {
    mirrorCursorAuthFiles(hostAuthPath, runtimeRoot)
    return true
  }

  const tokens = readDarwinCursorKeychainTokens(profile, hostEnvironment)
  if (tokens) {
    writeCursorRuntimeAuthPayload(runtimeRoot, tokens)
    return true
  }

  return false
}

export function materializeCursorAuth(
  runtimeRoot: string,
  workspaceRoot: string,
  profile: HostProfilePaths = resolveHostProfilePaths(),
  hostEnvironment: HostEnvironmentSnapshot = processHostEnvironmentSource.snapshot()
): MaterializeCursorResult {
  const hostAuthPath = resolveCursorHostAuthPath(profile)
  const runtimeAuthPath = runtimeCursorAuthPath(runtimeRoot)
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

  const authCopied = ensureCursorRuntimeAuth(runtimeRoot, profile, hostEnvironment)
  if (authCopied) {
    for (const path of [runtimeCursorCliAuthPath(runtimeRoot), runtimeAuthPath]) {
      if (existsSync(path)) copiedPaths.push(path)
    }
  }

  return {
    authCopied,
    runtimeAuthPath: existsSync(runtimeCursorCliAuthPath(runtimeRoot))
      ? runtimeCursorCliAuthPath(runtimeRoot)
      : runtimeAuthPath,
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

export function materializeOpencodeAuth(
  runtimeRoot: string,
  profile: HostProfilePaths = resolveHostProfilePaths()
): MaterializeOpencodeResult {
  const hostConfigDir = resolveOpencodeHostConfigDir(profile)
  const hostDataDir = resolveOpencodeHostDataDir(profile)
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

  writeCredentialSnapshotManifest(runtimeRoot, 'opencode', copied)

  return {
    configCopied: copied.length > 0,
    runtimeConfigDir,
    runtimeDataDir,
    hostConfigDir,
    cleanup: () => {
      scrubCredentialSnapshotManifest(runtimeRoot)
    }
  }
}
