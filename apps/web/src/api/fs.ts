import { api } from './client'
import type { ApiSuccess } from './types'

export type FilesystemRequestOptions = {
  headers?: HeadersInit
}

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

export function browseFilesystem(
  partialPath: string,
  options: FilesystemRequestOptions = {}
): Promise<ApiSuccess<BrowseResult>> {
  return api<BrowseResult>('/api/fs/browse', {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify({ partialPath })
  })
}

export function fetchBrowseParent(
  path: string,
  options: FilesystemRequestOptions = {}
): Promise<ApiSuccess<{ parentPath: string }>> {
  return api<{ parentPath: string }>(`/api/fs/parent?path=${encodeURIComponent(path)}`, {
    headers: options.headers
  })
}

export function resolveFilesystemFolder(
  path: string,
  createIfMissing = false,
  options: FilesystemRequestOptions = {}
): Promise<ApiSuccess<FolderSelection>> {
  return api<FolderSelection>('/api/fs/select', {
    method: 'POST',
    headers: options.headers,
    body: JSON.stringify({ path, createIfMissing })
  })
}
