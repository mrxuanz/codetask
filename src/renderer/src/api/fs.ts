import { api } from './client'
import type { ApiResponse } from './types'

export interface BrowseEntry {
  name: string
  path: string
}

export interface BrowseResult {
  parentPath: string
  entries: BrowseEntry[]
}

export function browseFilesystem(partialPath: string): Promise<ApiResponse<BrowseResult>> {
  return api<BrowseResult>('/api/fs/browse', {
    method: 'POST',
    body: JSON.stringify({ partialPath })
  })
}

export function fetchBrowseParent(path: string): Promise<ApiResponse<{ parentPath: string }>> {
  return api<{ parentPath: string }>(`/api/fs/parent?path=${encodeURIComponent(path)}`)
}
