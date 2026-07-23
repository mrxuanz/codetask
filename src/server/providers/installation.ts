import { createHash } from 'node:crypto'
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs'
import { basename, extname, join, normalize } from 'node:path'
import type {
  CommandInvocation,
  ProviderInstallation,
  ProviderInstallationSource
} from '../../shared/providers/installation'
import type { SupportedCoreCode } from '../../shared/providers/codes'
import type { ProviderSettings } from '../../shared/providers/settings'
import { getProviderDescriptor } from '../../shared/providers/descriptors'

export interface ProviderDiscoveryContext {
  readonly settings: ProviderSettings
  readonly hostEnv: Readonly<Record<string, string | undefined>>
  readonly platform?: NodeJS.Platform | undefined
  /** Test/packaging injection; production uses the provider's known install directories. */
  readonly installDirs?: readonly string[] | undefined
}

export type ProviderInstallationErrorCode =
  | 'configured-path-missing'
  | 'configured-path-not-file'
  | 'configured-path-not-executable'

export class ProviderInstallationError extends Error {
  constructor(
    readonly code: ProviderInstallationErrorCode,
    readonly path: string
  ) {
    super(`${code}: ${path}`)
    this.name = 'ProviderInstallationError'
  }
}

export interface ProviderInstallationResolver {
  resolve(
    provider: SupportedCoreCode,
    context: ProviderDiscoveryContext
  ): ProviderInstallation | null
}

function pathValue(
  env: Readonly<Record<string, string | undefined>>,
  key: string
): string | undefined {
  const exact = env[key]
  if (typeof exact === 'string') return exact
  const actual = Object.keys(env).find((name) => name.toLowerCase() === key.toLowerCase())
  return actual ? env[actual] : undefined
}

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return realpathSync(path)
  }
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function validateConfiguredPath(path: string, platform: NodeJS.Platform): string {
  if (!existsSync(path)) {
    throw new ProviderInstallationError('configured-path-missing', path)
  }
  let isFile = false
  try {
    isFile = statSync(path).isFile()
  } catch {
    throw new ProviderInstallationError('configured-path-missing', path)
  }
  if (!isFile) {
    throw new ProviderInstallationError('configured-path-not-file', path)
  }
  if (!isExecutableFile(path, platform)) {
    throw new ProviderInstallationError('configured-path-not-executable', path)
  }
  return safeRealpath(path)
}

function windowsExtensions(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  const raw = pathValue(env, 'PATHEXT') ?? '.COM;.EXE;.BAT;.CMD'
  return raw
    .split(';')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
}

function candidateNames(
  command: string,
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>
): readonly string[] {
  if (platform !== 'win32' || extname(command)) return [command]
  return [command, ...windowsExtensions(env).map((extension) => `${command}${extension}`)]
}

function findOnPath(
  commands: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): { command: string; path: string } | null {
  const path = pathValue(env, 'PATH')
  if (!path) return null
  const separator = platform === 'win32' ? ';' : ':'
  for (const command of commands) {
    for (const dir of path.split(separator).filter(Boolean)) {
      for (const name of candidateNames(command, platform, env)) {
        const candidate = join(dir.replace(/^"|"$/g, ''), name)
        if (isExecutableFile(candidate, platform)) {
          return { command, path: safeRealpath(candidate) }
        }
      }
    }
  }
  return null
}

function findInInstallDirs(
  commands: readonly string[],
  dirs: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform
): { command: string; path: string } | null {
  for (const dirOrFile of dirs) {
    if (isExecutableFile(dirOrFile, platform)) {
      const name = basename(dirOrFile)
      const command =
        commands.find((candidate) => name.toLowerCase().startsWith(candidate.toLowerCase())) ??
        commands[0] ??
        name
      return { command, path: safeRealpath(dirOrFile) }
    }
    for (const command of commands) {
      for (const name of candidateNames(command, platform, env)) {
        const candidate = join(dirOrFile, name)
        if (isExecutableFile(candidate, platform)) {
          return { command, path: safeRealpath(candidate) }
        }
      }
    }
  }
  return null
}

function invocationFor(resolvedPath: string, platform: NodeJS.Platform): CommandInvocation {
  const extension = extname(resolvedPath).toLowerCase()
  if (platform === 'win32' && extension === '.ps1') {
    return {
      executable: 'powershell.exe',
      prefixArgs: ['-NoProfile', '-NonInteractive', '-File', resolvedPath]
    }
  }
  return { executable: resolvedPath, prefixArgs: [] }
}

function installationId(
  provider: SupportedCoreCode,
  source: ProviderInstallationSource,
  invocation: CommandInvocation,
  resolvedPath: string
): string {
  const digest = createHash('sha256')
    .update(
      [provider, source, resolvedPath, invocation.executable, ...invocation.prefixArgs].join('\0')
    )
    .digest('hex')
    .slice(0, 20)
  return `${provider}:${digest}`
}

function createInstallation(input: {
  provider: SupportedCoreCode
  source: ProviderInstallationSource
  command: string
  resolvedPath: string
  platform: NodeJS.Platform
}): ProviderInstallation {
  const resolvedPath = normalize(input.resolvedPath)
  const invocation = invocationFor(resolvedPath, input.platform)
  return Object.freeze({
    id: installationId(input.provider, input.source, invocation, resolvedPath),
    provider: input.provider,
    command: input.command,
    source: input.source,
    invocation: Object.freeze({
      executable: invocation.executable,
      prefixArgs: Object.freeze([...invocation.prefixArgs])
    }),
    resolvedPath
  })
}

export class DefaultProviderInstallationResolver implements ProviderInstallationResolver {
  resolve(
    provider: SupportedCoreCode,
    context: ProviderDiscoveryContext
  ): ProviderInstallation | null {
    if (!context.settings.enabled) return null
    const descriptor = getProviderDescriptor(provider)
    const platform = context.platform ?? process.platform

    if (context.settings.executable.mode === 'path') {
      const resolvedPath = validateConfiguredPath(context.settings.executable.path, platform)
      return createInstallation({
        provider,
        source: 'app-config',
        command: basename(resolvedPath),
        resolvedPath,
        platform
      })
    }

    const fromInstall = findInInstallDirs(
      descriptor.defaultCommands,
      context.installDirs ?? [],
      context.hostEnv,
      platform
    )
    if (fromInstall) {
      return createInstallation({
        provider,
        source: 'install-dir',
        command: fromInstall.command,
        resolvedPath: fromInstall.path,
        platform
      })
    }

    const fromPath = findOnPath(descriptor.defaultCommands, context.hostEnv, platform)
    if (!fromPath) return null
    return createInstallation({
      provider,
      source: 'path',
      command: fromPath.command,
      resolvedPath: fromPath.path,
      platform
    })
  }
}

export const providerInstallationResolver: ProviderInstallationResolver =
  new DefaultProviderInstallationResolver()
