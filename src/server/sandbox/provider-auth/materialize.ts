/**
 * Credential materializers — diagnose / contract tests only.
 *
 * Production `prepareCodexAuth` / `prepareOpenCodeAuth` use host-identity +
 * precise path allowlists and must not call these helpers.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { chmodSync } from 'fs'
import { dirname, join } from 'path'
import {
  resolveCodexHostAuthPath,
  resolveCodexHostConfigPath,
  resolveHostProfilePaths,
  type HostProfilePaths,
  resolveOpencodeHostConfigDir,
  resolveOpencodeHostDataDir,
  runtimeCodexHome
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
