import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
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

export type CredentialMaterialization = 'reference' | 'snapshot'

/**
 * Prefer an absolute symlink so the isolated Provider home contains no second
 * credential payload. The outer sandbox separately grants read-only access to
 * the exact host credential file. Windows can reject unprivileged symlinks, so
 * it retains a narrow file-only snapshot fallback.
 */
export function materializeCredentialFile(
  source: string,
  destination: string
): CredentialMaterialization {
  ensureParentDir(destination)
  try {
    const stat = lstatSync(destination)
    if (!stat.isFile() && !stat.isSymbolicLink()) {
      throw new Error(`credential destination is not a file: ${destination}`)
    }
    unlinkSync(destination)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') throw error
  }

  try {
    symlinkSync(source, destination, process.platform === 'win32' ? 'file' : undefined)
    return 'reference'
  } catch (error) {
    if (process.platform !== 'win32') throw error
    copyAuthSnapshot(source, destination)
    return 'snapshot'
  }
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
  authMaterialized: boolean
  authMaterialization: CredentialMaterialization | null
  configGenerated: boolean
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
  let authMaterialized = false
  let authMaterialization: CredentialMaterialization | null = null
  let configGenerated = false

  if (existsSync(hostAuthPath)) {
    authMaterialization = materializeCredentialFile(hostAuthPath, runtimeAuthPath)
    authMaterialized = true
    cleanupPaths.push(runtimeAuthPath)
  }

  const hostConfigPath = resolveCodexHostConfigPath(profile)
  const runtimeConfigPath = join(codexHome, 'config.toml')

  if (existsSync(hostConfigPath)) {
    const filtered = filterCodexConfigToml(readFileSync(hostConfigPath, 'utf8'))
    writeFileSync(runtimeConfigPath, filtered, 'utf8')
    restrictFilePermissions(runtimeConfigPath)
    configGenerated = true
    cleanupPaths.push(runtimeConfigPath)
  }

  writeCredentialSnapshotManifest(runtimeRoot, 'codex', cleanupPaths)

  return {
    authMaterialized,
    authMaterialization,
    configGenerated,
    runtimeAuthPath,
    hostAuthPath,
    cleanup: () => {
      scrubCredentialSnapshotManifest(runtimeRoot)
    }
  }
}

export interface MaterializeCursorResult {
  authMaterialized: boolean
  materializations: CredentialMaterialization[]
  runtimeAuthPath: string
  runtimeConfigDir: string
  runtimeHome: string
  hostAuthPath: string
  hostReferencePaths: string[]
  cleanup: () => void
}

/** Cursor also checks `$HOME/.cursor/auth.json` on file-store installations. */
export function runtimeCursorCliAuthPath(runtimeRoot: string): string {
  return join(runtimeCursorHome(runtimeRoot), 'auth.json')
}

export function materializeCursorAuth(
  runtimeRoot: string,
  workspaceRoot: string,
  profile: HostProfilePaths = resolveHostProfilePaths()
): MaterializeCursorResult {
  const hostAuthPath = resolveCursorHostAuthPath(profile)
  const runtimeAuthPath = runtimeCursorAuthPath(runtimeRoot)
  const hostCursorHome = resolveCursorHostCursorHome(profile)
  const hostConfigDir = resolveCursorHostConfigDir(profile)

  const cursorHome = runtimeCursorHome(runtimeRoot)
  const cursorConfig = runtimeCursorConfigDir(runtimeRoot)
  const projectDir = join(cursorHome, 'projects', cursorProjectSlug(workspaceRoot))

  // Keep runtime sessions across turns. Only the exact host identity/config
  // files below are refreshed as references and scrubbed after the turn.
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

  const materializedPaths: string[] = []
  const materializations: CredentialMaterialization[] = []
  const hostReferencePaths: string[] = []

  const references: Array<{ host: string; runtime: string }> = [
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

  if (existsSync(hostAuthPath)) {
    references.push(
      { host: hostAuthPath, runtime: runtimeCursorCliAuthPath(runtimeRoot) },
      { host: hostAuthPath, runtime: runtimeAuthPath }
    )
  }

  for (const { host, runtime } of references) {
    if (!existsSync(host)) continue
    materializations.push(materializeCredentialFile(host, runtime))
    materializedPaths.push(runtime)
    hostReferencePaths.push(host)
  }

  writeCredentialSnapshotManifest(runtimeRoot, 'cursorcli', materializedPaths)

  return {
    authMaterialized: materializedPaths.length > 0,
    materializations,
    runtimeAuthPath: materializedPaths[0] ?? runtimeAuthPath,
    runtimeConfigDir: cursorConfig,
    runtimeHome: cursorHome,
    hostAuthPath,
    hostReferencePaths,
    cleanup: () => {
      scrubCredentialSnapshotManifest(runtimeRoot)
    }
  }
}

export interface MaterializeOpencodeResult {
  authMaterialized: boolean
  materializations: CredentialMaterialization[]
  configMaterialized: boolean
  configMaterializations: Array<CredentialMaterialization | 'projection'>
  runtimeConfigDir: string
  runtimeDataDir: string
  hostConfigDir: string
  hostCredentialPaths: string[]
  hostConfigPaths: string[]
  cleanup: () => void
}

const OPENCODE_HOST_CONFIG_KEYS = new Set([
  '$schema',
  'provider',
  'model',
  'small_model',
  'enabled_providers',
  'disabled_providers'
])

export function projectOpencodeHostConfig(raw: string): {
  safeToReference: boolean
  projected: string
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null

  const record = parsed as Record<string, unknown>
  const projected = Object.fromEntries(
    Object.entries(record).filter(([key]) => OPENCODE_HOST_CONFIG_KEYS.has(key))
  )
  return {
    safeToReference: Object.keys(record).every((key) => OPENCODE_HOST_CONFIG_KEYS.has(key)),
    projected: `${JSON.stringify(projected, null, 2)}\n`
  }
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

  const materialized: string[] = []
  const materializations: CredentialMaterialization[] = []
  const hostCredentialPaths: string[] = []
  const configMaterializations: Array<CredentialMaterialization | 'projection'> = []
  const hostConfigPaths: string[] = []
  const configCandidates = ['auth.json', 'credentials.json']
  const dataCandidates = ['auth.json', 'credentials.json']

  for (const name of configCandidates) {
    const source = join(hostConfigDir, name)
    if (!existsSync(source)) continue
    const dest = join(runtimeConfigDir, name)
    materializations.push(materializeCredentialFile(source, dest))
    materialized.push(dest)
    hostCredentialPaths.push(source)
  }

  for (const name of dataCandidates) {
    const source = join(hostDataDir, name)
    if (!existsSync(source)) continue
    const dest = join(runtimeDataDir, name)
    materializations.push(materializeCredentialFile(source, dest))
    materialized.push(dest)
    hostCredentialPaths.push(source)
  }

  for (const name of ['opencode.json', 'config.json'] as const) {
    const source = join(hostConfigDir, name)
    if (!existsSync(source)) continue
    const projection = projectOpencodeHostConfig(readFileSync(source, 'utf8'))
    if (!projection) continue
    const dest = join(runtimeConfigDir, name)
    if (projection.safeToReference) {
      configMaterializations.push(materializeCredentialFile(source, dest))
      hostConfigPaths.push(source)
    } else {
      writeFileSync(dest, projection.projected, { encoding: 'utf8', mode: 0o600 })
      restrictFilePermissions(dest)
      configMaterializations.push('projection')
    }
    materialized.push(dest)
  }

  writeCredentialSnapshotManifest(runtimeRoot, 'opencode', materialized)

  return {
    authMaterialized: materializations.length > 0,
    materializations,
    configMaterialized: configMaterializations.length > 0,
    configMaterializations,
    runtimeConfigDir,
    runtimeDataDir,
    hostConfigDir,
    hostCredentialPaths,
    hostConfigPaths,
    cleanup: () => {
      scrubCredentialSnapshotManifest(runtimeRoot)
    }
  }
}
