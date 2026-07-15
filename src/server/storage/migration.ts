import { randomUUID } from 'crypto'
import { existsSync, realpathSync } from 'fs'
import { copyFile, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import Database from 'better-sqlite3'
import type { AppContext } from '../context'
import { dataPaths } from '../data-paths'
import { beginDraining, endDraining } from '../legacy-control-plane/shutdown-state'
import { startRetentionJanitor, stopRetentionJanitor } from '../retention/lifecycle'
import { startAuthJanitor, stopAuthJanitor } from '../auth/janitor'
import { scrubCredentialSnapshotsInTree } from '../sandbox/provider-auth/snapshot-manifest'
import {
  StorageLocatorRepository,
  bootstrapPaths,
  createStorageLocator,
  readDataRootMarker,
  readStorageMigrationState,
  writeStorageMigrationState,
  type StorageMigrationState
} from '../../main/storage-locator'
import { validateStorageTarget } from '../../main/storage-validation'

export type StorageMigrationPhase =
  | 'validating_target'
  | 'draining'
  | 'checkpointing'
  | 'copying'
  | 'verifying'
  | 'switching_locator'
  | 'restart_required'
  | 'failed'

export interface StorageMigrationProgress {
  migrationId: string
  phase: StorageMigrationPhase
  oldDataDir: string
  targetDataDir: string
  copiedBytes: number
  copiedFiles: number
  startedAt: string
  updatedAt: string
  error?: string
}

const migrations = new Map<string, StorageMigrationProgress>()
let activeMigrationId: string | null = null

function isInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function nowIso(): string {
  return new Date().toISOString()
}

function durableState(
  progress: StorageMigrationProgress,
  stagingDir?: string
): StorageMigrationState {
  return {
    schemaVersion: 1,
    migrationId: progress.migrationId,
    phase: progress.phase,
    oldDataDir: progress.oldDataDir,
    targetDataDir: progress.targetDataDir,
    ...(stagingDir ? { stagingDir } : {}),
    startedAt: progress.startedAt,
    updatedAt: progress.updatedAt,
    ...(progress.error ? { error: progress.error } : {})
  }
}

function updateProgress(
  ctx: AppContext,
  progress: StorageMigrationProgress,
  phase: StorageMigrationPhase,
  patch: Partial<StorageMigrationProgress> = {},
  stagingDir?: string
): void {
  Object.assign(progress, patch, { phase, updatedAt: nowIso() })
  migrations.set(progress.migrationId, { ...progress })
  if (ctx.storage?.bootstrapRoot) {
    writeStorageMigrationState(
      bootstrapPaths(ctx.storage.bootstrapRoot),
      durableState(progress, stagingDir)
    )
  }
}

function assertIdle(ctx: AppContext): void {
  if (
    ctx.executionRuntime.findActiveLoopJobId() ||
    ctx.runtimeRegistry.hasInflightPlanning() ||
    ctx.runtimeRegistry.hasInflightThreads()
  ) {
    throw new Error('Storage migration requires all Provider workloads to be idle')
  }
}

async function copyTree(
  source: string,
  target: string,
  onFile: (bytes: number) => void,
  relativePath = ''
): Promise<void> {
  const sourcePath = relativePath ? join(source, relativePath) : source
  const targetPath = relativePath ? join(target, relativePath) : target
  await mkdir(targetPath, { recursive: true })
  for (const entry of await readdir(sourcePath, { withFileTypes: true })) {
    const rel = relativePath ? join(relativePath, entry.name) : entry.name
    const parts = rel.split(sep)
    const top = parts[0]
    if (top === 'secrets' || top === 'sandbox-home' || top === 'migration') continue
    if (parts[0] === 'config' && parts[1] === 'settings.json') continue
    if (parts[0] === 'blobs' && parts[1] === 'artifacts' && parts[2] === 'designs') continue
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      await copyTree(source, target, onFile, rel)
    } else if (entry.isFile()) {
      const from = join(source, rel)
      const to = join(target, rel)
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
      onFile((await stat(to)).size)
    }
  }
}

function sqliteClient(ctx: AppContext): Database.Database {
  const client = (ctx.db as typeof ctx.db & { $client?: Database.Database }).$client
  if (!client) throw new Error('Storage migration requires direct SQLite access')
  return client
}

function verifyTargetDatabase(ctx: AppContext, targetDataDir: string): void {
  const source = sqliteClient(ctx)
  const targetPath = dataPaths(targetDataDir).dbFile
  const target = new Database(targetPath, { readonly: true, fileMustExist: true })
  try {
    const quickCheck = target.pragma('quick_check', { simple: true })
    if (quickCheck !== 'ok') throw new Error(`Target SQLite quick_check failed: ${quickCheck}`)
    for (const table of ['thread_jobs', 'threads', 'thread_messages']) {
      const sourceCount = Number(
        (source.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
      )
      const targetCount = Number(
        (target.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
      )
      if (sourceCount !== targetCount) {
        throw new Error(`Storage migration row count mismatch for ${table}`)
      }
    }
  } finally {
    target.close()
  }
}

async function runMigration(ctx: AppContext, progress: StorageMigrationProgress): Promise<void> {
  const staging = join(
    dirname(progress.targetDataDir),
    `${basename(progress.targetDataDir)}.codetask-migrate-${progress.migrationId}`
  )
  let targetBackup: string | null = null
  let locatorSwitched = false
  try {
    assertIdle(ctx)
    updateProgress(ctx, progress, 'draining', {}, staging)
    beginDraining()
    stopRetentionJanitor()
    stopAuthJanitor()

    updateProgress(ctx, progress, 'checkpointing', {}, staging)
    sqliteClient(ctx).pragma('wal_checkpoint(TRUNCATE)')

    await rm(staging, { recursive: true, force: true })
    updateProgress(ctx, progress, 'copying', {}, staging)
    await copyTree(progress.oldDataDir, staging, (bytes) => {
      progress.copiedBytes += bytes
      progress.copiedFiles += 1
      progress.updatedAt = nowIso()
    })
    scrubCredentialSnapshotsInTree(dataPaths(staging).runtimes)

    updateProgress(ctx, progress, 'verifying', {}, staging)
    verifyTargetDatabase(ctx, staging)
    const sourceMarker = readDataRootMarker(progress.oldDataDir)
    const copiedMarker = readDataRootMarker(staging)
    if (
      !sourceMarker ||
      !copiedMarker ||
      sourceMarker.installationId !== copiedMarker.installationId
    ) {
      throw new Error('Storage migration marker verification failed')
    }

    if (existsSync(progress.targetDataDir)) {
      targetBackup = `${progress.targetDataDir}.codetask-backup-${progress.migrationId}`
      await rename(progress.targetDataDir, targetBackup)
    }
    await rename(staging, progress.targetDataDir)

    updateProgress(ctx, progress, 'switching_locator')
    const repository = new StorageLocatorRepository(bootstrapPaths(ctx.storage!.bootstrapRoot))
    repository.write(
      createStorageLocator({
        dataDir: progress.targetDataDir,
        source: 'migration',
        installationId: sourceMarker.installationId
      })
    )
    locatorSwitched = true
    updateProgress(ctx, progress, 'restart_required')
    if (targetBackup) {
      await rm(targetBackup, { recursive: true, force: true }).catch((error) => {
        console.warn('[storage] failed to remove replaced target backup', error)
      })
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    if (locatorSwitched) {
      Object.assign(progress, { phase: 'restart_required', updatedAt: nowIso() })
      migrations.set(progress.migrationId, { ...progress })
      console.error('[storage] locator switched but migration ledger update failed', error)
      return
    }
    if (targetBackup && !locatorSwitched) {
      await rm(progress.targetDataDir, { recursive: true, force: true }).catch(() => {})
      await rename(targetBackup, progress.targetDataDir).catch(() => {})
    }
    const message = error instanceof Error ? error.message : String(error)
    updateProgress(ctx, progress, 'failed', { error: message })
    endDraining()
    startRetentionJanitor()
    startAuthJanitor()
  } finally {
    if (progress.phase !== 'restart_required') activeMigrationId = null
  }
}

export function isStorageMigrationActive(): boolean {
  return activeMigrationId !== null
}

export function startStorageMigration(
  ctx: AppContext,
  targetPath: string
): StorageMigrationProgress {
  if (!ctx.storage?.bootstrapRoot) throw new Error('Storage location is not UI-managed')
  if (ctx.storage.managed) throw new Error('CLI/env managed storage cannot be changed in the UI')
  if (activeMigrationId) throw new Error('Another storage migration is already running')
  assertIdle(ctx)

  const sourceMarker = readDataRootMarker(ctx.dataDir)
  if (!sourceMarker) throw new Error('Current data root marker is missing or corrupt')
  const validation = validateStorageTarget({
    path: targetPath,
    forbiddenRoots: [ctx.storage.bootstrapRoot, ctx.dataDir],
    expectedInstallationId: sourceMarker.installationId
  })
  if (!validation.ok) throw new Error(validation.issue ?? 'Storage target validation failed')
  const source = realpathSync.native(ctx.dataDir)
  if (isInside(source, validation.canonicalPath) || isInside(validation.canonicalPath, source)) {
    throw new Error('Storage target must not contain or be contained by the current data root')
  }

  const migrationId = randomUUID()
  const startedAt = nowIso()
  const progress: StorageMigrationProgress = {
    migrationId,
    phase: 'validating_target',
    oldDataDir: source,
    targetDataDir: validation.canonicalPath,
    copiedBytes: 0,
    copiedFiles: 0,
    startedAt,
    updatedAt: startedAt
  }
  activeMigrationId = migrationId
  migrations.set(migrationId, { ...progress })
  writeStorageMigrationState(bootstrapPaths(ctx.storage.bootstrapRoot), durableState(progress))
  void runMigration(ctx, progress)
  return { ...progress }
}

export function getStorageMigration(
  ctx: AppContext,
  migrationId: string
): StorageMigrationProgress | null {
  const memory = migrations.get(migrationId)
  if (memory) return { ...memory }
  if (!ctx.storage?.bootstrapRoot) return null
  const state = readStorageMigrationState(bootstrapPaths(ctx.storage.bootstrapRoot))
  if (!state || state.migrationId !== migrationId) return null
  return {
    migrationId: state.migrationId,
    phase: state.phase as StorageMigrationPhase,
    oldDataDir: state.oldDataDir,
    targetDataDir: state.targetDataDir,
    copiedBytes: 0,
    copiedFiles: 0,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    ...(state.error ? { error: state.error } : {})
  }
}

export async function confirmOldStorageDelete(
  ctx: AppContext,
  migrationId: string
): Promise<boolean> {
  if (!ctx.storage?.bootstrapRoot) return false
  const paths = bootstrapPaths(ctx.storage.bootstrapRoot)
  const state = readStorageMigrationState(paths)
  if (!state || state.migrationId !== migrationId || state.phase !== 'restart_required')
    return false
  if (resolve(ctx.dataDir) !== resolve(state.targetDataDir)) return false
  const oldMarker = readDataRootMarker(state.oldDataDir)
  const newMarker = readDataRootMarker(state.targetDataDir)
  if (!oldMarker || !newMarker || oldMarker.installationId !== newMarker.installationId)
    return false
  await rm(state.oldDataDir, { recursive: true, force: true })
  writeStorageMigrationState(paths, {
    ...state,
    phase: 'complete',
    updatedAt: nowIso()
  })
  return true
}
