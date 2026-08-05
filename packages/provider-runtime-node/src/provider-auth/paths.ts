import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import type { Dirent } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { processHostEnvironmentSource } from '@codetask/agent-runtime/host-environment'

type HostEnvironment = Readonly<Record<string, string | undefined>>

export interface HostProfilePaths {
  home: string
  appData: string
  localAppData: string
}

export function resolveHostProfilePaths(
  env: HostEnvironment = processHostEnvironmentSource.snapshot(),
  platform: NodeJS.Platform = process.platform
): HostProfilePaths {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()

  if (platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
    return { home, appData, localAppData }
  }

  if (platform === 'darwin') {
    return {
      home,
      appData: join(home, 'Library', 'Application Support'),
      localAppData: join(home, 'Library', 'Caches')
    }
  }

  return {
    home,
    appData: join(home, '.config'),
    localAppData: join(home, '.local', 'share')
  }
}

export function resolveCodexHostAuthPath(profile = resolveHostProfilePaths()): string {
  return join(resolveCodexHostHome(profile), 'auth.json')
}

export function resolveCodexHostHome(profile = resolveHostProfilePaths()): string {
  return join(profile.home, '.codex')
}

export function resolveCodexHostConfigPath(profile = resolveHostProfilePaths()): string {
  return join(resolveCodexHostHome(profile), 'config.toml')
}

export function resolveCursorHostAuthPathCandidates(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform === 'win32') {
    return [join(profile.appData, 'Cursor', 'auth.json')]
  }

  if (platform === 'darwin') {
    return [
      join(profile.appData, 'Cursor', 'auth.json'),
      join(resolveCursorHostConfigDir(profile, platform), 'auth.json')
    ]
  }

  return [join(resolveCursorHostConfigDir(profile, platform), 'auth.json')]
}

export function resolveCursorHostAuthPath(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string {
  const candidates = resolveCursorHostAuthPathCandidates(profile, platform)
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

  return {
    present: sources.some((path) => path.endsWith('auth.json')),
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
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): CursorHostAuthSnapshot {
  const authCandidates = resolveCursorHostAuthPathCandidates(profile, platform)
  const authPath =
    authCandidates.find((candidate) => existsSync(candidate)) ?? authCandidates[0] ?? ''
  const cursorHome = resolveCursorHostCursorHome(profile)
  const configDir = resolveCursorHostConfigDir(profile, platform)
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

  return {
    present: authCandidates.some((candidate) => existsSync(candidate)),
    authPath,
    cursorHome,
    configDir,
    sources
  }
}

export function resolveClaudeHostConfigDir(profile = resolveHostProfilePaths()): string {
  return join(profile.home, '.claude')
}

export function resolveClaudeProjectConfigDir(workspaceRoot: string): string {
  return join(workspaceRoot, '.claude')
}

const CLAUDE_SETTINGS_FILENAMES = ['settings.json', 'settings.local.json'] as const

/** Profile / toolchain keys must never be overridden from Claude settings.env. */
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

const CLAUDE_SETTINGS_BLOCKED_ENV_PREFIXES = [
  'CODETASK_',
  'ELECTRON_',
  'CHROME_',
  'CRASHPAD_'
] as const

/**
 * Whitelist for Claude settings.json `env` injection into outer-sandbox turns.
 * Only Anthropic auth / endpoint / model keys — never PATH/HOME or CodeTask controls.
 */
export function isAllowedClaudeSettingsEnvKey(key: string): boolean {
  const upper = key.toUpperCase()
  if (CLAUDE_SETTINGS_BLOCKED_ENV_KEYS.has(upper)) return false
  if (CLAUDE_SETTINGS_BLOCKED_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix))) return false
  return upper.startsWith('ANTHROPIC_') || upper === 'CLAUDE_CODE_OAUTH_TOKEN'
}

export function readClaudeSettingsEnv(settingsPath: string): Record<string, string> {
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
  /** Whitelisted auth/model env extracted from settings.json (never secrets from Keychain). */
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

/** Merge host user settings.env whitelist for outer-sandbox Claude turns. */
export function resolveClaudeSettingsAuthEnv(
  profile = resolveHostProfilePaths()
): Record<string, string> {
  return { ...snapshotClaudeHostSettings(profile).env }
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

export function resolveOpencodeHostConfigDir(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') return join(profile.appData, 'opencode')
  return join(profile.home, '.config', 'opencode')
}

export function resolveOpencodeHostDataDir(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') return join(profile.localAppData, 'opencode')
  return join(profile.home, '.local', 'share', 'opencode')
}

/**
 * OpenCode XDG state (locks, kv, prompt-history). Distinct from config/data.
 * Honors host `XDG_STATE_HOME` when set; otherwise platform defaults.
 */
export function resolveOpencodeHostStateDir(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform,
  env: HostEnvironment = processHostEnvironmentSource.snapshot()
): string {
  const xdgState = env.XDG_STATE_HOME?.trim()
  if (xdgState) return join(xdgState, 'opencode')
  if (platform === 'win32') return join(profile.localAppData, 'state', 'opencode')
  return join(profile.home, '.local', 'state', 'opencode')
}

export interface OpencodeHostAuthSnapshot {
  present: boolean
  configDir: string
  dataDir: string
  stateDir: string
  sources: string[]
}

export function snapshotOpencodeHostAuth(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform,
  env: HostEnvironment = processHostEnvironmentSource.snapshot()
): OpencodeHostAuthSnapshot {
  const configDir = resolveOpencodeHostConfigDir(profile, platform)
  const dataDir = resolveOpencodeHostDataDir(profile, platform)
  const stateDir = resolveOpencodeHostStateDir(profile, platform, env)
  const sources: string[] = []

  for (const name of ['opencode.json', 'auth.json', 'config.json', 'credentials.json'] as const) {
    const path = join(configDir, name)
    if (existsSync(path)) sources.push(path)
  }

  for (const name of ['auth.json', 'credentials.json'] as const) {
    const path = join(dataDir, name)
    if (existsSync(path)) sources.push(path)
  }

  return {
    present: sources.some((path) => {
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      return name === 'auth.json' || name === 'credentials.json'
    }),
    configDir,
    dataDir,
    stateDir,
    sources
  }
}

export function resolveCursorAgentInstallDirs(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const dirs: string[] = []
  if (platform === 'win32') {
    dirs.push(join(profile.localAppData, 'cursor-agent'))
    dirs.push(join(profile.localAppData, 'Programs', 'cursor-agent'))
  } else if (platform === 'darwin') {
    dirs.push(join(profile.appData, 'Cursor'))
    dirs.push(join(profile.home, '.local', 'share', 'cursor-agent'))
    dirs.push(join(profile.home, '.cursor-agent'))
  } else {
    dirs.push(join(profile.appData, 'Cursor'))
    dirs.push(join(profile.home, '.local', 'share', 'cursor-agent'))
    dirs.push(join(profile.home, '.cursor-agent'))
  }

  return dirs
}

export function resolveCursorCompileCacheDirs(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const candidates =
    platform === 'darwin'
      ? [join(profile.localAppData, 'cursor-compile-cache')]
      : platform === 'win32'
        ? [join(profile.localAppData, 'cursor-compile-cache')]
        : [join(profile.home, '.cache', 'cursor-compile-cache')]
  return candidates.filter((path) => existsSync(path))
}

export function resolveDarwinKeychainReadRoots(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string[] {
  if (platform !== 'darwin') return []
  return [join(profile.home, 'Library', 'Keychains'), join('/Library', 'Keychains')].filter(
    (path) => existsSync(path)
  )
}

export function resolveCursorAgentMarkerWriteDirs(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string[] {
  const dirs: string[] = []
  for (const installRoot of resolveCursorAgentInstallDirs(profile, platform)) {
    const versionsRoot = join(installRoot, 'versions')
    let versions: Dirent[]
    try {
      versions = readdirSync(versionsRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const version of versions) {
      if (!version.isDirectory()) continue
      const running = join(versionsRoot, version.name, '.running')
      if (existsSync(running)) dirs.push(running)
    }
  }
  return dirs
}

function addExistingDir(dirs: Set<string>, path: string | null | undefined): void {
  if (!path || !existsSync(path)) return
  dirs.add(path)
}

interface PackageMetadata {
  readonly name?: string
  readonly optionalDependencies?: Readonly<Record<string, string>>
}

function readPackageMetadata(packageJson: string): PackageMetadata | null {
  try {
    return JSON.parse(readFileSync(packageJson, 'utf8')) as PackageMetadata
  } catch {
    return null
  }
}

function resolvePackageJson(packageName: string, from: string): string | null {
  const req = createRequire(from)
  try {
    return req.resolve(`${packageName}/package.json`)
  } catch {
    // Some SDKs export their entry point but intentionally hide package.json.
  }

  try {
    let directory = dirname(req.resolve(packageName))
    while (true) {
      const packageJson = join(directory, 'package.json')
      if (readPackageMetadata(packageJson)?.name === packageName) return packageJson
      const parent = dirname(directory)
      if (parent === directory) return null
      directory = parent
    }
  } catch {
    return null
  }
}

function resolveInstalledOptionalPackageRoots(packageJson: string): string[] {
  const metadata = readPackageMetadata(packageJson)
  const req = createRequire(packageJson)
  const roots: string[] = []
  for (const packageName of Object.keys(metadata?.optionalDependencies ?? {})) {
    const dependencyPackageJson = resolvePackageJson(packageName, packageJson)
    if (!dependencyPackageJson) continue
    // Resolve from the owning package as well as the application root; this
    // supports npm's flat layout and pnpm's nested/linked layout.
    try {
      roots.push(dirname(req.resolve(`${packageName}/package.json`)))
    } catch {
      roots.push(dirname(dependencyPackageJson))
    }
  }
  return roots
}

function addExecutableParentDirs(
  dirs: Set<string>,
  root: string,
  executableNames: ReadonlySet<string>,
  maxDepth = 6
): void {
  const visit = (directory: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    if (entries.some((entry) => entry.isFile() && executableNames.has(entry.name.toLowerCase()))) {
      addExistingDir(dirs, directory)
    }
    for (const entry of entries) {
      if (entry.isDirectory()) visit(join(directory, entry.name), depth + 1)
    }
  }
  visit(root, 0)
}

export function resolveCodexInstallDirs(): string[] {
  const dirs = new Set<string>()

  try {
    const codexPkgJson = resolvePackageJson('@openai/codex', __filename)
    if (!codexPkgJson) return []
    const codexRoot = dirname(codexPkgJson)
    addExistingDir(dirs, codexRoot)
    addExistingDir(dirs, join(codexRoot, 'bin'))
    for (const nativeRoot of resolveInstalledOptionalPackageRoots(codexPkgJson)) {
      addExistingDir(dirs, nativeRoot)
      addExecutableParentDirs(dirs, nativeRoot, new Set(['codex', 'codex.exe']))
    }
  } catch {
    // ignore
  }

  return [...dirs.values()]
}

export function resolveClaudeInstallDirs(): string[] {
  const dirs = new Set<string>()

  try {
    const sdkPkgJson = resolvePackageJson('@anthropic-ai/claude-agent-sdk', __filename)
    if (!sdkPkgJson) return []
    const sdkRoot = dirname(sdkPkgJson)
    addExistingDir(dirs, sdkRoot)
    for (const nativeRoot of resolveInstalledOptionalPackageRoots(sdkPkgJson)) {
      addExistingDir(dirs, nativeRoot)
      addExecutableParentDirs(dirs, nativeRoot, new Set(['claude', 'claude.exe']))
    }
  } catch {
    // ignore
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

  return [...dirs.values()]
}

export function resolveOpencodeExecutable(
  env:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = processHostEnvironmentSource.snapshot()
): string {
  // Prefer unified ProviderInstallation resolution; BIN env is no longer a config source.
  try {
    const nodeRequire = createRequire(__filename)
    const { resolveProviderExecutable } = nodeRequire(
      '../providers/executable.ts'
    ) as typeof import('../providers/executable')
    const resolved = resolveProviderExecutable('opencode', { env })
    if (resolved?.executable) return resolved.executable
  } catch {
    // Fall through to install-dir / bare command.
  }

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

export function resolveCursorHostCursorHome(profile = resolveHostProfilePaths()): string {
  return join(profile.home, '.cursor')
}

export function resolveCursorHostConfigDir(
  profile = resolveHostProfilePaths(),
  platform: NodeJS.Platform = process.platform
): string {
  if (platform === 'win32') {
    return join(profile.appData, 'cursor')
  }
  return join(profile.home, '.config', 'cursor')
}
