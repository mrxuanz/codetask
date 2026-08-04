import { ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { browseFilesystem, fetchBrowseParent, resolveFilesystemFolder } from '@renderer/api/fs'
import type { BrowseEntry } from '@renderer/api/fs'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { defaultBrowsePath, joinChildPath, withTrailingSeparator } from '@renderer/lib/workspace'

export interface FolderBrowseReturn {
  query: Ref<string>
  parentPath: Ref<string>
  entries: Ref<BrowseEntry[]>
  newFolderName: Ref<string>
  loading: Ref<boolean>
  error: Ref<string | null>
  reset: () => void
  loadBrowse: (partialPath: string) => Promise<void>
  currentDirectoryPath: () => string
  openEntry: (entry: BrowseEntry) => void
  goParent: () => Promise<void>
  joinNewFolderPath: () => string
  selectFolder: (path?: string) => Promise<string | null>
  createFolder: () => Promise<string | null>
  start: () => void
}

export function useFolderBrowse(options?: { active?: Ref<boolean> }): FolderBrowseReturn {
  const { t } = useI18n()

  const query = ref(defaultBrowsePath())
  const parentPath = ref('')
  const entries = ref<BrowseEntry[]>([])
  const newFolderName = ref('')
  const loading = ref(false)
  const error = ref<string | null>(null)

  function reset(): void {
    query.value = defaultBrowsePath()
    parentPath.value = ''
    entries.value = []
    newFolderName.value = ''
    error.value = null
    loading.value = false
  }

  async function loadBrowse(partialPath: string): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await browseFilesystem(partialPath)
      parentPath.value = res.data.parentPath
      entries.value = res.data.entries
      if (!partialPath.trim()) {
        query.value = res.data.parentPath
      }
    } catch (err) {
      parentPath.value = ''
      entries.value = []
      const message = err instanceof Error ? err.message : t('folderPicker.browseFailed')
      error.value = translateApiError(message, t)
    } finally {
      loading.value = false
    }
  }

  function currentDirectoryPath(): string {
    return parentPath.value || query.value.trim()
  }

  function openEntry(entry: BrowseEntry): void {
    query.value = withTrailingSeparator(entry.path)
    newFolderName.value = ''
  }

  async function goParent(): Promise<void> {
    const target = currentDirectoryPath()
    if (!target) return
    loading.value = true
    error.value = null
    try {
      const res = await fetchBrowseParent(target)
      query.value = withTrailingSeparator(res.data.parentPath)
      newFolderName.value = ''
      await loadBrowse(query.value)
    } catch (err) {
      const message = err instanceof Error ? err.message : t('folderPicker.parentFailed')
      error.value = translateApiError(message, t)
    } finally {
      loading.value = false
    }
  }

  function joinNewFolderPath(): string {
    return joinChildPath(currentDirectoryPath(), newFolderName.value)
  }

  async function resolveSelection(
    target: string,
    createIfMissing: boolean
  ): Promise<string | null> {
    if (!target.trim()) {
      error.value = t(
        createIfMissing ? 'folderPicker.folderNameRequired' : 'folderPicker.selectRequired'
      )
      return null
    }
    loading.value = true
    error.value = null
    try {
      const result = await resolveFilesystemFolder(target, createIfMissing)
      return result.data.path
    } catch (err) {
      const message = err instanceof Error ? err.message : t('folderPicker.browseFailed')
      error.value = translateApiError(message, t)
      return null
    } finally {
      loading.value = false
    }
  }

  function selectFolder(path = currentDirectoryPath()): Promise<string | null> {
    return resolveSelection(path, false)
  }

  async function createFolder(): Promise<string | null> {
    const path = await resolveSelection(joinNewFolderPath(), true)
    if (!path) return null
    newFolderName.value = ''
    query.value = withTrailingSeparator(path)
    await loadBrowse(query.value)
    return path
  }

  function start(): void {
    reset()
    query.value = defaultBrowsePath()
    void loadBrowse(query.value)
  }

  let browseTimer: number | undefined
  watch(query, (value) => {
    if (options?.active && !options.active.value) return
    if (browseTimer !== undefined) {
      window.clearTimeout(browseTimer)
    }
    browseTimer = window.setTimeout(() => {
      void loadBrowse(value)
    }, 200)
  })

  return {
    query,
    parentPath,
    entries,
    newFolderName,
    loading,
    error,
    reset,
    loadBrowse,
    currentDirectoryPath,
    openEntry,
    goParent,
    joinNewFolderPath,
    selectFolder,
    createFolder,
    start
  }
}
