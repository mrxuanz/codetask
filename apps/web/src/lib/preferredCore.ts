const STORAGE_KEY = 'task_preferred_core_code'

export function getPreferredProviderCode(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value?.trim() || null
  } catch {
    return null
  }
}

export function setPreferredProviderCode(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code.trim())
  } catch {
    // ignore
  }
}
