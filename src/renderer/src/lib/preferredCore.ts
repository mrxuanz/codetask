const STORAGE_KEY = 'task_preferred_core_code'

export function getPreferredCoreCode(): string | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value?.trim() || null
  } catch {
    return null
  }
}

export function setPreferredCoreCode(code: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, code.trim())
  } catch {
    // ignore
  }
}
