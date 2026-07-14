import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

export interface HostProfilePaths {
  home: string
  appData: string
  localAppData: string
}

export function resolveHostProfilePaths(): HostProfilePaths {
  const home =
    process.env.CODETASK_HOST_HOME?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim() ||
    homedir()

  if (process.platform === 'win32') {
    const appData =
      process.env.CODETASK_HOST_APPDATA?.trim() ||
      process.env.APPDATA?.trim() ||
      join(home, 'AppData', 'Roaming')
    const localAppData =
      process.env.CODETASK_HOST_LOCALAPPDATA?.trim() ||
      process.env.LOCALAPPDATA?.trim() ||
      join(home, 'AppData', 'Local')
    return { home, appData, localAppData }
  }

  if (process.platform === 'darwin') {
    return {
      home,
      appData:
        process.env.CODETASK_HOST_APPDATA?.trim() || join(home, 'Library', 'Application Support'),
      localAppData:
        process.env.CODETASK_HOST_LOCALAPPDATA?.trim() || join(home, 'Library', 'Caches')
    }
  }

  return {
    home,
    appData: process.env.CODETASK_HOST_APPDATA?.trim() || join(home, '.config'),
    localAppData: process.env.CODETASK_HOST_LOCALAPPDATA?.trim() || join(home, '.local', 'share')
  }
}

export function resolveCodexHostAuthPath(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_CODEX_AUTH_PATH?.trim()
  if (override) return override
  return join(resolveCodexHostHome(profile), 'auth.json')
}

export function resolveCodexHostHome(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_CODEX_HOME?.trim()
  if (override) return override
  return join(profile.home, '.codex')
}

export function resolveCodexHostConfigPath(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_CODEX_CONFIG_PATH?.trim()
  if (override) return override
  return join(resolveCodexHostHome(profile), 'config.toml')
}

export function resolveCursorHostAuthPathCandidates(profile = resolveHostProfilePaths()): string[] {
  const override = process.env.CODETASK_CURSOR_AUTH_PATH?.trim()
  if (override) return [override]

  if (process.platform === 'win32') {
    return [join(profile.appData, 'Cursor', 'auth.json')]
  }

  if (process.platform === 'darwin') {
    return [
      join(profile.appData, 'Cursor', 'auth.json'),
      join(resolveCursorHostConfigDir(profile), 'auth.json')
    ]
  }

  return [join(resolveCursorHostConfigDir(profile), 'auth.json')]
}

export function resolveCursorHostAuthPath(profile = resolveHostProfilePaths()): string {
  const candidates = resolveCursorHostAuthPathCandidates(profile)
  return candidates.find((path) => existsSync(path)) ?? candidates[0] ?? ''
}

export interface CodexHostAuthSnapshot {
  present: boolean
  codexHome: string
  sources: string[]
}

export function snapshotCodexHostAuth(profile = resolveHostProfilePaths()): CodexHostAuthSnapshot {
  const codexHome = resolveCodexHostHome(profile)
  const sources: string[] = []

  for (const name of ['auth.json', 'config.toml'] as const) {
    const path = join(codexHome, name)
    if (existsSync(path)) sources.push(path)
  }

  const hasEnvKey = Boolean(process.env.OPENAI_API_KEY?.trim() || process.env.CODEX_API_KEY?.trim())

  return {
    present: sources.some((path) => path.endsWith('auth.json')) || hasEnvKey,
    codexHome,
    sources
  }
}

export interface CursorHostAuthSnapshot {
  present: boolean
  authPath: string
  cursorHome: string
  configDir: string
  sources: string[]
}

export function snapshotCursorHostAuth(
  profile = resolveHostProfilePaths()
): CursorHostAuthSnapshot {
  const authCandidates = resolveCursorHostAuthPathCandidates(profile)
  const authPath =
    authCandidates.find((candidate) => existsSync(candidate)) ?? authCandidates[0] ?? ''
  const cursorHome = resolveCursorHostCursorHome(profile)
  const configDir = resolveCursorHostConfigDir(profile)
  const sources: string[] = []

  for (const candidate of authCandidates) {
    if (existsSync(candidate)) sources.push(candidate)
  }

  for (const name of ['cli-config.json', 'agent-cli-state.json'] as const) {
    const path = join(cursorHome, name)
    if (existsSync(path)) sources.push(path)
  }

  for (const name of ['cli-config.json', 'acp-config.json'] as const) {
    const path = join(configDir, name)
    if (existsSync(path)) sources.push(path)
  }

  const hasEnvKey = Boolean(process.env.CURSOR_API_KEY?.trim())

  return {
    present: authCandidates.some((candidate) => existsSync(candidate)) || hasEnvKey,
    authPath,
    cursorHome,
    configDir,
    sources
  }
}

export function resolveClaudeHostConfigDir(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_CLAUDE_CONFIG_DIR?.trim()
  if (override) return override
  return join(profile.home, '.claude')
}

export function resolveClaudeProjectConfigDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.claude')
}

const CLAUDE_SETTINGS_FILENAMES = ['settings.json', 'settings.local.json'] as const

const CLAUDE_SETTINGS_BLOCKED_ENV_PREFIXES = [
  'CODETASK_',
  'ELECTRON_',
  'CHROME_',
  'CRASHPAD_'
] as const

const CLAUDE_SETTINGS_BLOCKED_ENV_KEYS = new Set([
  'PATH',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'TMPDIR',
  'TEMP',
  'TMP',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'CLAUDE_CONFIG_DIR'
])

function isAllowedClaudeSettingsEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (CLAUDE_SETTINGS_BLOCKED_ENV_KEYS.has(upper)) return false
  if (CLAUDE_SETTINGS_BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false
  return upper.startsWith('ANTHROPIC_') || upper === 'CLAUDE_CODE_OAUTH_TOKEN'
}

function readClaudeSettingsEnv(settingsPath: string): Record<string, string> {
  if (!existsSync(settingsPath)) return {}
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      env?: Record<string, unknown>
    }
    const env = parsed.env
    if (!env || typeof env !== 'object') return {}
    const out: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string' || !value.trim()) continue
      if (!isAllowedClaudeSettingsEnvKey(key)) continue
      out[key] = value.trim()
    }
    return out
  } catch {
    return {}
  }
}

function snapshotClaudeSettingsInDir(configDir: string): {
  configDir: string
  sources: string[]
  env: Record<string, string>
} {
  const sources: string[] = []
  const env: Record<string, string> = {}
  for (const name of CLAUDE_SETTINGS_FILENAMES) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    sources.push(path)
    Object.assign(env, readClaudeSettingsEnv(path))
  }
  return { configDir, sources, env }
}

export interface ClaudeHostSettingsSnapshot {
  present: boolean
  configDir: string
  settingsPath: string
  sources: string[]
  env: Record<string, string>
}

export function snapshotClaudeHostSettings(
  profile = resolveHostProfilePaths()
): ClaudeHostSettingsSnapshot {
  const configDir = resolveClaudeHostConfigDir(profile)
  const snapshot = snapshotClaudeSettingsInDir(configDir)
  return {
    present: snapshot.sources.length > 0,
    configDir,
    settingsPath: join(configDir, 'settings.json'),
    sources: snapshot.sources,
    env: snapshot.env
  }
}

export function snapshotClaudeProjectSettings(workspaceRoot: string): {
  configDir: string
  sources: string[]
  env: Record<string, string>
} {
  return snapshotClaudeSettingsInDir(resolveClaudeProjectConfigDir(workspaceRoot))
}

export function resolveClaudeConfigReadRoots(
  profile = resolveHostProfilePaths(),
  workspaceRoot?: string
): string[] {
  const host = snapshotClaudeHostSettings(profile)
  const roots = [host.configDir, ...host.sources]
  if (workspaceRoot?.trim()) {
    const project = snapshotClaudeProjectSettings(workspaceRoot.trim())
    roots.push(project.configDir, ...project.sources)
  }
  return roots
}

export function resolveOpencodeHostConfigDir(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_OPENCODE_CONFIG_DIR?.trim()
  if (override) return override
  return join(profile.home, '.config', 'opencode')
}

export function resolveOpencodeHostDataDir(profile = resolveHostProfilePaths()): string {
  const override = process.env.CODETASK_OPENCODE_DATA_DIR?.trim()
  if (override) return override
  return join(profile.home, '.local', 'share', 'opencode')
}

export interface OpencodeHostAuthSnapshot {
  present: boolean
  configDir: string
  dataDir: string
  sources: string[]
}

export function snapshotOpencodeHostAuth(
  profile = resolveHostProfilePaths()
): OpencodeHostAuthSnapshot {
  const configDir = resolveOpencodeHostConfigDir(profile)
  const dataDir = resolveOpencodeHostDataDir(profile)
  const sources: string[] = []

  for (const name of ['opencode.json', 'auth.json', 'config.json', 'credentials.json'] as const) {
    const path = join(configDir, name)
    if (existsSync(path)) sources.push(path)
  }

  for (const name of ['auth.json', 'credentials.json'] as const) {
    const path = join(dataDir, name)
    if (existsSync(path)) sources.push(path)
  }

  return { present: sources.length > 0, configDir, dataDir, sources }
}

export function resolveCursorAgentInstallDirs(profile = resolveHostProfilePaths()): string[] {
  const dirs: string[] = []
  const override = process.env.CODETASK_CURSOR_AGENT_DIR?.trim()
  if (override) {
    dirs.push(override)
    return dirs
  }

  if (process.platform === 'win32') {
    dirs.push(join(profile.localAppData, 'cursor-agent'))
    dirs.push(join(profile.localAppData, 'Programs', 'cursor-agent'))
  } else if (process.platform === 'darwin') {
    dirs.push(join(profile.appData, 'Cursor'))
    dirs.push(join(profile.home, '.cursor-agent'))
  } else {
    dirs.push(join(profile.appData, 'Cursor'))
    dirs.push(join(profile.home, '.local', 'share', 'cursor-agent'))
    dirs.push(join(profile.home, '.cursor-agent'))
  }

  return dirs
}

const CODEX_NATIVE_TARGET_BY_PLATFORM: Partial<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
}

const CODEX_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64'
}

function addExistingDir(dirs: Set<string>, path: string | null | undefined): void {
  if (!path || !existsSync(path)) return
  dirs.add(path)
}

export function resolveCodexInstallDirs(): string[] {
  const dirs = new Set<string>()
  const targetTriple = CODEX_NATIVE_TARGET_BY_PLATFORM[`${process.platform}-${process.arch}`]
  const platformPackage = targetTriple ? CODEX_PLATFORM_PACKAGE_BY_TARGET[targetTriple] : undefined

  try {
    const req = createRequire(__filename)
    const codexPkgJson = req.resolve('@openai/codex/package.json')
    const codexRoot = dirname(codexPkgJson)
    addExistingDir(dirs, codexRoot)
    addExistingDir(dirs, join(codexRoot, 'bin'))

    if (platformPackage) {
      const codexReq = createRequire(codexPkgJson)
      const nativePkgJson = codexReq.resolve(`${platformPackage}/package.json`)
      const nativeRoot = dirname(nativePkgJson)
      addExistingDir(dirs, nativeRoot)
      const vendorRoot = join(nativeRoot, 'vendor')
      addExistingDir(dirs, vendorRoot)
      if (targetTriple) {
        const tripleRoot = join(vendorRoot, targetTriple)
        addExistingDir(dirs, tripleRoot)
        addExistingDir(dirs, join(tripleRoot, 'bin'))
        addExistingDir(dirs, join(tripleRoot, 'codex-path'))
        addExistingDir(dirs, join(tripleRoot, 'codex-resources'))
      }
    }
  } catch {
    // ignore
  }

  const override = process.env.CODETASK_CODEX_INSTALL_DIR?.trim()
  if (override) {
    addExistingDir(dirs, override)
  }

  return [...dirs.values()]
}

const CLAUDE_NATIVE_TARGET_BY_PLATFORM: Partial<Record<string, string>> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu'
}

const CLAUDE_PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-pc-windows-msvc': '@anthropic-ai/claude-agent-sdk-win32-x64',
  'aarch64-pc-windows-msvc': '@anthropic-ai/claude-agent-sdk-win32-arm64',
  'x86_64-apple-darwin': '@anthropic-ai/claude-agent-sdk-darwin-x64',
  'aarch64-apple-darwin': '@anthropic-ai/claude-agent-sdk-darwin-arm64',
  'x86_64-unknown-linux-gnu': '@anthropic-ai/claude-agent-sdk-linux-x64',
  'aarch64-unknown-linux-gnu': '@anthropic-ai/claude-agent-sdk-linux-arm64'
}

export function resolveClaudeInstallDirs(): string[] {
  const dirs = new Set<string>()
  const targetTriple = CLAUDE_NATIVE_TARGET_BY_PLATFORM[`${process.platform}-${process.arch}`]
  const platformPackage = targetTriple ? CLAUDE_PLATFORM_PACKAGE_BY_TARGET[targetTriple] : undefined

  try {
    const req = createRequire(__filename)
    const sdkPkgJson = req.resolve('@anthropic-ai/claude-agent-sdk/package.json')
    const sdkRoot = dirname(sdkPkgJson)
    addExistingDir(dirs, sdkRoot)

    if (platformPackage) {
      const sdkReq = createRequire(sdkPkgJson)
      const nativePkgJson = sdkReq.resolve(`${platformPackage}/package.json`)
      const nativeRoot = dirname(nativePkgJson)
      addExistingDir(dirs, nativeRoot)
    }
  } catch {
    // ignore
  }

  const override = process.env.CODETASK_CLAUDE_INSTALL_DIR?.trim()
  if (override) {
    addExistingDir(dirs, override)
  }

  return [...dirs.values()]
}

function addOpencodeCliRoots(dirs: Set<string>, cliPath: string): void {
  const trimmed = cliPath.trim().replace(/^"|"$/g, '')
  if (!trimmed || !existsSync(trimmed)) return

  addExistingDir(dirs, trimmed)
  const parent = dirname(trimmed)
  addExistingDir(dirs, parent)

  const packageBin = join(parent, 'node_modules', 'opencode-ai', 'bin')
  addExistingDir(dirs, packageBin)
  addExistingDir(dirs, join(parent, 'node_modules', 'opencode-ai'))

  try {
    const resolved = realpathSync(trimmed)
    addExistingDir(dirs, resolved)
    addExistingDir(dirs, dirname(resolved))
    const resolvedParent = dirname(resolved)
    addExistingDir(dirs, join(resolvedParent, '..', 'node_modules', 'opencode-ai', 'bin'))
    addExistingDir(dirs, join(resolvedParent, '..', 'node_modules', 'opencode-ai'))
  } catch {
    // ignore
  }
}

export function resolveOpencodeInstallDirs(): string[] {
  const dirs = new Set<string>()

  for (const pkg of ['opencode-ai', '@opencode-ai/sdk'] as const) {
    try {
      const req = createRequire(__filename)
      const pkgJson = req.resolve(`${pkg}/package.json`)
      const pkgRoot = dirname(pkgJson)
      addExistingDir(dirs, pkgRoot)
      addExistingDir(dirs, join(pkgRoot, 'bin'))
    } catch {
      // ignore
    }
  }

  try {
    if (process.platform === 'win32') {
      const output = execFileSync('where', ['opencode'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of output.split(/\r?\n/)) {
        addOpencodeCliRoots(dirs, line)
      }
    } else {
      const output = execFileSync('which', ['opencode'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      })
      for (const line of output.split(/\r?\n/)) {
        addOpencodeCliRoots(dirs, line)
      }
    }
  } catch {
    // ignore
  }

  const override = process.env.CODETASK_OPENCODE_INSTALL_DIR?.trim()
  if (override) {
    addExistingDir(dirs, override)
  }

  return [...dirs.values()]
}

export function resolveOpencodeExecutable(): string {
  const fromEnv = process.env.CODETASK_OPENCODE_BIN?.trim()
  if (fromEnv && existsSync(fromEnv)) return fromEnv

  const exeNames = process.platform === 'win32' ? ['opencode.exe'] : ['opencode', 'opencode.exe']
  for (const dir of resolveOpencodeInstallDirs()) {
    for (const exeName of exeNames) {
      if (dir.toLowerCase().endsWith(exeName.toLowerCase()) && existsSync(dir)) {
        return dir
      }
      const candidate = join(dir, exeName)
      if (existsSync(candidate)) return candidate
    }
  }

  return exeNames[0] ?? 'opencode'
}

export const RUNTIME_CODEX_HOME_DIR = join('provider', 'codex')

export function runtimeCodexHome(runtimeRoot: string): string {
  return join(runtimeRoot, RUNTIME_CODEX_HOME_DIR)
}

export function runtimeCursorHome(runtimeRoot: string): string {
  return join(runtimeRoot, '.cursor')
}

export function runtimeCursorConfigDir(runtimeRoot: string): string {
  return join(runtimeRoot, 'config', 'cursor')
}

export function cursorProjectSlug(workspaceRoot: string): string {
  return (
    workspaceRoot
      .replace(/^[\\/]+/, '')
      .replace(/:/g, '')
      .replace(/[\\/]+/g, '-')
      .replace(/[^A-Za-z0-9._-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'workspace'
  )
}

export function resolveCursorHostCursorHome(profile = resolveHostProfilePaths()): string {
  return join(profile.home, '.cursor')
}

export function resolveCursorHostConfigDir(profile = resolveHostProfilePaths()): string {
  if (process.platform === 'win32') {
    return join(profile.appData, 'cursor')
  }
  return join(profile.home, '.config', 'cursor')
}

export function runtimeCursorAuthPath(runtimeRoot: string): string {
  if (process.platform === 'win32') {
    return join(runtimeRoot, 'AppData', 'Roaming', 'Cursor', 'auth.json')
  }
  return join(runtimeRoot, 'config', 'cursor', 'auth.json')
}
