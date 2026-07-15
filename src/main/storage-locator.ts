import { randomUUID } from 'crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'

export const DATA_ROOT_MARKER_FILENAME = '.codetask-data.json'
export const STORAGE_LOCATOR_SCHEMA_VERSION = 1
export const DATA_ROOT_FORMAT_VERSION = 1

export type StorageLocationSource = 'desktop_setup' | 'default' | 'recovered' | 'migration'

export type DataDirSource = 'cli' | 'env' | 'locator' | 'candidate'

export interface DataDirResolution {
  phase: 'ready' | 'selection_required' | 'recovery_required'
  dataDir: string
  source: DataDirSource
  managed: boolean
  bootstrap: BootstrapPaths
  issue?: string
}

export interface BootstrapPaths {
  root: string
  bootstrapDir: string
  locatorFile: string
  migrationStateFile: string
  logsDir: string
  secretsDir: string
  authSecretFile: string
  mcpSecretFile: string
}

export interface StorageLocator {
  schemaVersion: 1
  dataDir: string
  selectedAt: string
  source: StorageLocationSource
  installationId: string
}

export interface DataRootMarker {
  formatVersion: 1
  installationId: string
  createdAt: string
}

export interface StorageMigrationState {
  schemaVersion: 1
  migrationId: string
  phase: string
  oldDataDir: string
  targetDataDir: string
  stagingDir?: string
  startedAt: string
  updatedAt: string
  error?: string
}

export type LocatorReadResult =
  | { status: 'missing' }
  | { status: 'valid'; locator: StorageLocator }
  | { status: 'corrupt'; issue: string }

export function bootstrapPaths(root: string): BootstrapPaths {
  const absolute = resolve(root)
  const bootstrapDir = join(absolute, 'bootstrap')
  const secretsDir = join(absolute, 'secrets')
  return {
    root: absolute,
    bootstrapDir,
    locatorFile: join(bootstrapDir, 'storage-location.json'),
    migrationStateFile: join(bootstrapDir, 'migration-state.json'),
    logsDir: join(absolute, 'logs'),
    secretsDir,
    authSecretFile: join(secretsDir, 'auth-secret'),
    mcpSecretFile: join(secretsDir, 'mcp-secrets.json')
  }
}

function atomicWriteJson(path: string, value: unknown, mode = 0o600): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  let fd: number | null = null
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
    // Windows FlushFileBuffers requires write access; 'r' fails with EPERM.
    fd = openSync(tmp, 'r+')
    fsyncSync(fd)
    closeSync(fd)
    fd = null
    renameSync(tmp, path)

    if (process.platform !== 'win32') {
      const parentFd = openSync(dirname(path), 'r')
      try {
        fsyncSync(parentFd)
      } finally {
        closeSync(parentFd)
      }
    }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

function parseStorageLocator(raw: unknown): StorageLocator | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (
    value.schemaVersion !== STORAGE_LOCATOR_SCHEMA_VERSION ||
    typeof value.dataDir !== 'string' ||
    !isAbsolute(value.dataDir) ||
    typeof value.selectedAt !== 'string' ||
    typeof value.installationId !== 'string' ||
    !value.installationId.trim() ||
    !isStorageLocationSource(value.source)
  ) {
    return null
  }
  return {
    schemaVersion: STORAGE_LOCATOR_SCHEMA_VERSION,
    dataDir: resolve(value.dataDir),
    selectedAt: value.selectedAt,
    source: value.source,
    installationId: value.installationId
  }
}

function isStorageLocationSource(value: unknown): value is StorageLocationSource {
  return (
    typeof value === 'string' &&
    ['desktop_setup', 'default', 'recovered', 'migration'].includes(value)
  )
}

function parseDataRootMarker(raw: unknown): DataRootMarker | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (
    value.formatVersion !== DATA_ROOT_FORMAT_VERSION ||
    typeof value.installationId !== 'string' ||
    !value.installationId.trim() ||
    typeof value.createdAt !== 'string'
  ) {
    return null
  }
  return {
    formatVersion: DATA_ROOT_FORMAT_VERSION,
    installationId: value.installationId,
    createdAt: value.createdAt
  }
}

export class StorageLocatorRepository {
  constructor(readonly paths: BootstrapPaths) {}

  read(): LocatorReadResult {
    if (!existsSync(this.paths.locatorFile)) return { status: 'missing' }
    try {
      const locator = parseStorageLocator(JSON.parse(readFileSync(this.paths.locatorFile, 'utf8')))
      if (!locator) return { status: 'corrupt', issue: 'storage_locator_invalid' }
      return { status: 'valid', locator }
    } catch {
      return { status: 'corrupt', issue: 'storage_locator_unreadable' }
    }
  }

  write(locator: StorageLocator): void {
    const parsed = parseStorageLocator(locator)
    if (!parsed) throw new Error('Invalid storage locator')
    atomicWriteJson(this.paths.locatorFile, parsed)
  }
}

export function readStorageMigrationState(paths: BootstrapPaths): StorageMigrationState | null {
  if (!existsSync(paths.migrationStateFile)) return null
  try {
    const value = JSON.parse(
      readFileSync(paths.migrationStateFile, 'utf8')
    ) as StorageMigrationState
    if (
      value.schemaVersion !== 1 ||
      typeof value.migrationId !== 'string' ||
      typeof value.phase !== 'string' ||
      !isAbsolute(value.oldDataDir) ||
      !isAbsolute(value.targetDataDir)
    ) {
      return null
    }
    return value
  } catch {
    return null
  }
}

export function writeStorageMigrationState(
  paths: BootstrapPaths,
  state: StorageMigrationState
): void {
  atomicWriteJson(paths.migrationStateFile, state)
}

export function dataRootMarkerPath(dataDir: string): string {
  return join(resolve(dataDir), DATA_ROOT_MARKER_FILENAME)
}

export function readDataRootMarker(dataDir: string): DataRootMarker | null {
  const path = dataRootMarkerPath(dataDir)
  if (!existsSync(path)) return null
  try {
    return parseDataRootMarker(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function writeDataRootMarker(
  dataDir: string,
  installationId = randomUUID()
): DataRootMarker {
  const absolute = resolve(dataDir)
  mkdirSync(absolute, { recursive: true })
  const current = readDataRootMarker(absolute)
  if (current) {
    if (current.installationId !== installationId) {
      throw new Error('Data root belongs to a different CodeTask installation')
    }
    return current
  }
  if (existsSync(dataRootMarkerPath(absolute))) {
    throw new Error('Data root marker is corrupt')
  }

  const marker: DataRootMarker = {
    formatVersion: DATA_ROOT_FORMAT_VERSION,
    installationId,
    createdAt: new Date().toISOString()
  }
  atomicWriteJson(dataRootMarkerPath(absolute), marker)
  return marker
}

export function validateLocatorMarker(locator: StorageLocator): string | null {
  if (!existsSync(locator.dataDir)) return 'storage_data_root_missing'
  try {
    if (!statSync(locator.dataDir).isDirectory()) return 'storage_data_root_not_directory'
  } catch {
    return 'storage_data_root_unreadable'
  }
  const marker = readDataRootMarker(locator.dataDir)
  if (!marker) return 'storage_data_root_marker_missing_or_invalid'
  if (marker.installationId !== locator.installationId) {
    return 'storage_installation_id_mismatch'
  }
  return null
}

/** True when a broken locator target can be safely re-initialized (missing or empty). */
export function canReinitializeBrokenDataRoot(dataDir: string): boolean {
  const absolute = resolve(dataDir)
  if (!existsSync(absolute)) return true
  try {
    if (!statSync(absolute).isDirectory()) return false
  } catch {
    return false
  }
  if (readDataRootMarker(absolute)) return false
  try {
    return readdirSync(absolute).length === 0
  } catch {
    return false
  }
}

export function createStorageLocator(input: {
  dataDir: string
  source: StorageLocationSource
  installationId: string
}): StorageLocator {
  if (!isAbsolute(input.dataDir)) throw new Error('Storage data directory must be absolute')
  return {
    schemaVersion: STORAGE_LOCATOR_SCHEMA_VERSION,
    dataDir: resolve(input.dataDir),
    selectedAt: new Date().toISOString(),
    source: input.source,
    installationId: input.installationId
  }
}

/** Pure path/source resolver used by both Electron composition and Node integration tests. */
export function resolveStorageLocation(input: {
  explicitDataDir?: string
  envDataDir?: string
  mode: 'desktop' | 'server'
  bootstrapRoot: string
  defaultDataDir: string
}): DataDirResolution {
  const bootstrap = bootstrapPaths(input.bootstrapRoot)
  const cliDir = input.explicitDataDir?.trim()
  if (cliDir) {
    return {
      phase: 'ready',
      dataDir: resolve(cliDir),
      source: 'cli',
      managed: true,
      bootstrap
    }
  }

  const envDir = input.envDataDir?.trim()
  if (envDir) {
    return {
      phase: 'ready',
      dataDir: resolve(envDir),
      source: 'env',
      managed: true,
      bootstrap
    }
  }

  const repository = new StorageLocatorRepository(bootstrap)
  const locatorRead = repository.read()
  if (locatorRead.status === 'corrupt') {
    return {
      phase: 'recovery_required',
      dataDir: '',
      source: 'locator',
      managed: false,
      bootstrap,
      issue: locatorRead.issue
    }
  }
  if (locatorRead.status === 'valid') {
    const issue = validateLocatorMarker(locatorRead.locator)
    if (!issue) {
      return {
        phase: 'ready',
        dataDir: locatorRead.locator.dataDir,
        source: 'locator',
        managed: false,
        bootstrap
      }
    }

    // Stale locator after a wiped/empty data root: let the user initialize again
    // instead of forcing "recover an existing CodeTask directory".
    if (
      (issue === 'storage_data_root_missing' ||
        issue === 'storage_data_root_marker_missing_or_invalid') &&
      canReinitializeBrokenDataRoot(locatorRead.locator.dataDir)
    ) {
      return {
        phase: 'selection_required',
        dataDir: locatorRead.locator.dataDir,
        source: 'candidate',
        managed: false,
        bootstrap
      }
    }

    return {
      phase: 'recovery_required',
      dataDir: locatorRead.locator.dataDir,
      source: 'locator',
      managed: false,
      bootstrap,
      issue
    }
  }

  const candidate = resolve(input.defaultDataDir)
  return {
    phase: 'selection_required',
    dataDir: candidate,
    source: 'candidate',
    managed: false,
    bootstrap
  }
}

/** Ensure an operator-managed root has an identity marker before any database is opened. */
export function ensureResolvedDataRoot(resolution: DataDirResolution): string {
  if (resolution.phase !== 'ready' || !resolution.dataDir) {
    throw new Error(resolution.issue ?? 'Storage data root is not ready')
  }
  const dataDir = resolve(resolution.dataDir)
  mkdirSync(dataDir, { recursive: true })
  const marker = readDataRootMarker(dataDir)
  if (marker) return dataDir
  if (existsSync(dataRootMarkerPath(dataDir))) {
    throw new Error('Storage data root marker is corrupt')
  }

  const entries = readdirSync(dataDir)
  if (entries.length > 0) {
    throw new Error('Refusing to initialize a non-empty directory without a CodeTask marker')
  }
  writeDataRootMarker(dataDir)
  return dataDir
}
