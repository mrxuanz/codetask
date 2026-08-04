import { api } from './client'
import type { ApiSuccess } from './types'

export interface BrowseEntry {
  name: string
  path: string
}

export interface BrowseResult {
  parentPath: string
  entries: BrowseEntry[]
}

export interface FolderSelection {
  path: string
  created: boolean
}

export function browseFilesystem(partialPath: string): Promise<ApiSuccess<BrowseResult>> {
  return api<BrowseResult>('/api/fs/browse', {
    method: 'POST',
    body: JSON.stringify({ partialPath })
  })
}

export function fetchBrowseParent(path: string): Promise<ApiSuccess<{ parentPath: string }>> {
  return api<{ parentPath: string }>(`/api/fs/parent?path=${encodeURIComponent(path)}`)
}

export function resolveFilesystemFolder(
  path: string,
  createIfMissing = false
): Promise<ApiSuccess<FolderSelection>> {
  return api<FolderSelection>('/api/fs/select', {
    method: 'POST',
    body: JSON.stringify({ path, createIfMissing })
  })
}
