import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'

export const INITIALIZATION_CONFIG_FILENAME = 'codetask-data.json'
export const INITIALIZATION_CONFIG_FORMAT_VERSION = 1 as const

export interface InitializationConfig {
  formatVersion: typeof INITIALIZATION_CONFIG_FORMAT_VERSION
  installationId: string
  createdAt: string
  /** Absolute SQLite file path. Empty until first-run setup. */
  dbPath: string
}

export function resolveInitializationConfigPath(input: {
  isPackaged: boolean
  executablePath: string
  developmentRoot: string
}): string {
  const configRoot = input.isPackaged
    ? dirname(resolve(input.executablePath))
    : resolve(input.developmentRoot)
  return join(configRoot, INITIALIZATION_CONFIG_FILENAME)
}

export function resolveInitializationDefaultDataDir(configPath: string): string {
  return join(dirname(resolve(configPath)), 'data')
}

function createInitializationConfig(): InitializationConfig {
  return {
    formatVersion: INITIALIZATION_CONFIG_FORMAT_VERSION,
    installationId: randomUUID(),
    createdAt: new Date().toISOString(),
    dbPath: ''
  }
}

function atomicWriteInitializationConfig(configPath: string, config: InitializationConfig): void {
  const absoluteConfigPath = resolve(configPath)
  mkdirSync(dirname(absoluteConfigPath), { recursive: true })
  const temporaryPath = `${absoluteConfigPath}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    })
    renameSync(temporaryPath, absoluteConfigPath)
  } finally {
    rmSync(temporaryPath, { force: true })
  }
}

function readLegacyDataRootIdentity(dataDir: string): {
  installationId: string
  createdAt: string
  path: string
} | null {
  const path = join(resolve(dataDir), '.codetask-data.json')
  if (!existsSync(path)) return null
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    if (
      value.formatVersion !== 1 ||
      typeof value.installationId !== 'string' ||
      !value.installationId.trim() ||
      typeof value.createdAt !== 'string' ||
      !value.createdAt.trim()
    ) {
      return null
    }
    return {
      installationId: value.installationId,
      createdAt: value.createdAt,
      path
    }
  } catch {
    return null
  }
}

function normalizeConfiguredStorage(config: InitializationConfig): {
  config: InitializationConfig
  legacyMarkerPath?: string
} {
  if (!config.dbPath) return { config }
  const isDatabasePath =
    basename(config.dbPath) === 'app.db' && basename(dirname(config.dbPath)) === 'db'
  const dataDir = isDatabasePath ? dirname(dirname(config.dbPath)) : config.dbPath
  const legacyIdentity = readLegacyDataRootIdentity(dataDir)
  return {
    config: {
      ...config,
      ...(legacyIdentity
        ? {
            installationId: legacyIdentity.installationId,
            createdAt: legacyIdentity.createdAt
          }
        : {}),
      dbPath: join(resolve(dataDir), 'db', 'app.db')
    },
    ...(legacyIdentity ? { legacyMarkerPath: legacyIdentity.path } : {})
  }
}

export function readInitializationConfig(configPath: string): InitializationConfig {
  const absoluteConfigPath = resolve(configPath)
  if (!existsSync(absoluteConfigPath)) {
    throw new Error(`Initialization config not found: ${absoluteConfigPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(absoluteConfigPath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Initialization config is not valid JSON: ${absoluteConfigPath} (${message})`)
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Initialization config must be a JSON object: ${absoluteConfigPath}`)
  }

  const value = raw as Record<string, unknown>
  const dbPath = value.dbPath
  if (typeof dbPath !== 'string') {
    throw new Error(`Initialization config dbPath must be a string: ${absoluteConfigPath}`)
  }
  if (
    value.formatVersion !== undefined &&
    value.formatVersion !== INITIALIZATION_CONFIG_FORMAT_VERSION
  ) {
    throw new Error(`Initialization config formatVersion is not supported: ${absoluteConfigPath}`)
  }
  if (value.installationId !== undefined && typeof value.installationId !== 'string') {
    throw new Error(`Initialization config installationId must be a string: ${absoluteConfigPath}`)
  }
  if (value.createdAt !== undefined && typeof value.createdAt !== 'string') {
    throw new Error(`Initialization config createdAt must be a string: ${absoluteConfigPath}`)
  }

  const configuredPath = dbPath.trim()
  return {
    formatVersion: INITIALIZATION_CONFIG_FORMAT_VERSION,
    installationId:
      typeof value.installationId === 'string' && value.installationId.trim()
        ? value.installationId
        : randomUUID(),
    createdAt:
      typeof value.createdAt === 'string' && value.createdAt.trim()
        ? value.createdAt
        : new Date().toISOString(),
    dbPath: configuredPath
      ? isAbsolute(configuredPath)
        ? resolve(configuredPath)
        : resolve(dirname(absoluteConfigPath), configuredPath)
      : ''
  }
}

/** Create the first-run config beside the development root/executable, then read it. */
export function ensureInitializationConfig(configPath: string): InitializationConfig {
  const absoluteConfigPath = resolve(configPath)
  if (!existsSync(absoluteConfigPath)) {
    try {
      mkdirSync(dirname(absoluteConfigPath), { recursive: true })
      writeFileSync(
        absoluteConfigPath,
        `${JSON.stringify(createInitializationConfig(), null, 2)}\n`,
        {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600
        }
      )
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const normalized = normalizeConfiguredStorage(readInitializationConfig(absoluteConfigPath))
  const config = normalized.config
  const raw = JSON.parse(readFileSync(absoluteConfigPath, 'utf8')) as Record<string, unknown>
  if (
    raw.formatVersion !== config.formatVersion ||
    raw.installationId !== config.installationId ||
    raw.createdAt !== config.createdAt ||
    raw.dbPath !== config.dbPath
  ) {
    atomicWriteInitializationConfig(absoluteConfigPath, config)
  }
  if (normalized.legacyMarkerPath) {
    rmSync(normalized.legacyMarkerPath, { force: true })
  }
  return config
}

/** Persist the canonical SQLite file selected by first-run storage setup. */
export function writeInitializationConfig(
  configPath: string,
  dbPath: string
): InitializationConfig {
  const absoluteConfigPath = resolve(configPath)
  const configuredPath = dbPath.trim()
  const canonicalPath = configuredPath
    ? isAbsolute(configuredPath)
      ? resolve(configuredPath)
      : resolve(dirname(absoluteConfigPath), configuredPath)
    : ''
  const current = ensureInitializationConfig(absoluteConfigPath)
  atomicWriteInitializationConfig(absoluteConfigPath, { ...current, dbPath: canonicalPath })
  return readInitializationConfig(absoluteConfigPath)
}
