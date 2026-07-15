import { api } from './client'
import type { ApiResponse } from './types'

export interface StorageBootstrapData {
  phase: 'selection_required' | 'ready' | 'recovery_required'
  defaultCandidate: string
  source: 'none' | 'cli' | 'env' | 'locator'
  managed: boolean
  issue?: string
}

export interface StorageValidationData {
  ok: boolean
  canonicalPath: string
  availableBytes: number | null
  warnings: string[]
  nonce: string
}

export function fetchStorageBootstrap(): Promise<ApiResponse<StorageBootstrapData>> {
  return api<StorageBootstrapData>('/api/system/storage/bootstrap')
}

export function validateStorageTarget(path: string): Promise<ApiResponse<StorageValidationData>> {
  return api<StorageValidationData>('/api/system/storage/validate', {
    method: 'POST',
    body: JSON.stringify({ path })
  })
}

export function initializeStorageTarget(
  path: string,
  validationNonce: string
): Promise<ApiResponse<{ phase: 'restart_required'; dataDir: string }>> {
  return api<{ phase: 'restart_required'; dataDir: string }>('/api/system/storage/initialize', {
    method: 'POST',
    body: JSON.stringify({ path, validationNonce })
  })
}

export function recoverStorageTarget(
  path: string,
  validationNonce: string
): Promise<ApiResponse<{ phase: 'restart_required'; dataDir: string }>> {
  return api<{ phase: 'restart_required'; dataDir: string }>('/api/system/storage/recover', {
    method: 'POST',
    body: JSON.stringify({ path, validationNonce })
  })
}

export interface StorageStatsData {
  dataDir: string
  source: string
  managed: boolean
  bytes: {
    total: number
    database: number
    wal: number
    attachments: number
    artifacts: number
    runtimes: number
  }
  sqlite: { freelistPages: number; pageSize: number; reclaimableBytes: number }
}

export interface StorageMigrationData {
  migrationId: string
  phase:
    | 'validating_target'
    | 'draining'
    | 'checkpointing'
    | 'copying'
    | 'verifying'
    | 'switching_locator'
    | 'restart_required'
    | 'failed'
  oldDataDir: string
  targetDataDir: string
  copiedBytes: number
  copiedFiles: number
  startedAt: string
  updatedAt: string
  error?: string
}

export function fetchStorageStats(): Promise<ApiResponse<StorageStatsData>> {
  return api<StorageStatsData>('/api/settings/storage')
}

export function startStorageMigration(
  targetPath: string
): Promise<ApiResponse<StorageMigrationData>> {
  return api<StorageMigrationData>('/api/settings/storage/migrations', {
    method: 'POST',
    body: JSON.stringify({ targetPath })
  })
}

export function fetchStorageMigration(
  migrationId: string
): Promise<ApiResponse<StorageMigrationData>> {
  return api<StorageMigrationData>(`/api/settings/storage/migrations/${migrationId}`)
}

export function confirmOldStorageDelete(
  migrationId: string
): Promise<ApiResponse<{ deleted: boolean }>> {
  return api<{ deleted: boolean }>(
    `/api/settings/storage/migrations/${migrationId}/confirm-old-delete`,
    { method: 'POST' }
  )
}
