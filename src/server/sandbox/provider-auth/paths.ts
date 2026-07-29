import { createRequire } from 'module'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, realpathSync } from 'fs'
import type { Dirent } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { processHostEnvironmentSource } from '../../host-environment'

type HostEnvironment = Readonly<Record<string, string | undefined>>

export interface HostProfilePaths {
  home: string
  appData: string
  localAppData: string
}

export function resolveHostProfilePaths(
  env: HostEnvironment = processHostEnvironmentSource.snapshot()
): HostProfilePaths {
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir()

  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local')
    return { home, appData, localAppData }
  }

  if (process.platform === 'darwin') {
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

export function resolveCursorHostAuthPathCandidates(profile = resolveHostProfilePaths()): string[] {
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

function snapshotClaudeSettingsInDir(configDir: string): {
  configDir: string
  sources: string[]
} {
  const sources: string[] = []
  for (const name of CLAUDE_SETTINGS_FILENAMES) {
    const path = join(configDir, name)
    if (!existsSync(path)) continue
    sources.push(path)
  }
  return { configDir, sources }
}

export interface ClaudeHostSettingsSnapshot {
  present: boolean
  configDir: string
  settingsPath: string
  sources: string[]
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
    sources: snapshot.sources
  }
}

export function snapshotClaudeProjectSettings(workspaceRoot: string): {
  configDir: string
  sources: string[]
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
  return join(profile.home, '.config', 'opencode')
}

export function resolveOpencodeHostDataDir(profile = resolveHostProfilePaths()): string {
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

  return {
    present: sources.some((path) => {
      const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
      return name === 'auth.json' || name === 'credentials.json'
    }),
    configDir,
    dataDir,
    sources
  }
}

export function resolveCursorAgentInstallDirs(profile = resolveHostProfilePaths()): string[] {
  const dirs: string[] = []
  if (process.platform === 'win32') {
    dirs.push(join(profile.localAppData, 'cursor-agent'))
    dirs.push(join(profile.localAppData, 'Programs', 'cursor-agent'))
  } else if (process.platform === 'darwin') {
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
  profile = resolveHostProfilePaths()
): string[] {
  const candidates =
    process.platform === 'darwin'
      ? [join(profile.localAppData, 'cursor-compile-cache')]
      : process.platform === 'win32'
        ? [join(profile.localAppData, 'cursor-compile-cache')]
        : [join(profile.home, '.cache', 'cursor-compile-cache')]
  return candidates.filter((path) => existsSync(path))
}

export function resolveDarwinKeychainReadRoots(
  profile = resolveHostProfilePaths()
): string[] {
  if (process.platform !== 'darwin') return []
  return [join(profile.home, 'Library', 'Keychains'), join('/Library', 'Keychains')].filter(
    (path) => existsSync(path)
  )
}

export function resolveCursorAgentMarkerWriteDirs(
  profile = resolveHostProfilePaths()
): string[] {
  const dirs: string[] = []
  for (const installRoot of resolveCursorAgentInstallDirs(profile)) {
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
      '../../providers/executable.ts'
    ) as typeof import('../../providers/executable')
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
