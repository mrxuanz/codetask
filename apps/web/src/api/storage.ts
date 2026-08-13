import { api } from './client'
import { SETUP_TOKEN_HEADER } from '@codetask/contracts'
import type { ApiSuccess } from './types'

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

export function fetchStorageBootstrap(
  setupToken?: string
): Promise<ApiSuccess<StorageBootstrapData>> {
  return api<StorageBootstrapData>('/api/system/storage/bootstrap', {
    headers: setupTokenHeaders(setupToken)
  })
}

function setupTokenHeaders(setupToken?: string): HeadersInit | undefined {
  const token = setupToken?.trim()
  return token ? { [SETUP_TOKEN_HEADER]: token } : undefined
}

export function validateStorageTarget(
  path: string,
  setupToken?: string
): Promise<ApiSuccess<StorageValidationData>> {
  return api<StorageValidationData>('/api/system/storage/validate', {
    method: 'POST',
    headers: setupTokenHeaders(setupToken),
    body: JSON.stringify({ path })
  })
}

export function initializeStorageTarget(
  path: string,
  validationNonce: string,
  setupToken?: string
): Promise<ApiSuccess<{ phase: 'ready'; dataDir: string }>> {
  return api<{ phase: 'ready'; dataDir: string }>('/api/system/storage/initialize', {
    method: 'POST',
    headers: setupTokenHeaders(setupToken),
    body: JSON.stringify({ path, validationNonce })
  })
}

export function recoverStorageTarget(
  path: string,
  validationNonce: string,
  setupToken?: string
): Promise<ApiSuccess<{ phase: 'ready'; dataDir: string }>> {
  return api<{ phase: 'ready'; dataDir: string }>('/api/system/storage/recover', {
    method: 'POST',
    headers: setupTokenHeaders(setupToken),
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
  }
  sqlite: { freelistPages: number; pageSize: number; reclaimableBytes: number }
}

export function fetchStorageStats(): Promise<ApiSuccess<StorageStatsData>> {
  return api<StorageStatsData>('/api/system/storage')
}
