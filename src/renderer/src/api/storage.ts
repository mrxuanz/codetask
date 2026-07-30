import { api } from './client'
import type { ApiResponse } from './types'

export interface StorageBootstrapData {
  phase: 'selection_required' | 'ready'
  defaultCandidate: string
  source: 'none' | 'config'
  issue?: string
}

export interface StorageValidationData {
  ok: boolean
  canonicalPath: string
  availableBytes: number | null
  warnings: string[]
  nonce: string
  action?: 'initialize' | 'recover'
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
): Promise<ApiResponse<{ phase: 'ready'; dataDir: string }>> {
  return api<{ phase: 'ready'; dataDir: string }>('/api/system/storage/initialize', {
    method: 'POST',
    body: JSON.stringify({ path, validationNonce })
  })
}

export function recoverStorageTarget(
  path: string,
  validationNonce: string
): Promise<ApiResponse<{ phase: 'ready'; dataDir: string }>> {
  return api<{ phase: 'ready'; dataDir: string }>('/api/system/storage/recover', {
    method: 'POST',
    body: JSON.stringify({ path, validationNonce })
  })
}

export interface StorageStatsData {
  dataDir: string
  source: string
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

export function fetchStorageStats(): Promise<ApiResponse<StorageStatsData>> {
  return api<StorageStatsData>('/api/settings/storage')
}
