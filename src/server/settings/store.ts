import { getAppContext } from '../bootstrap'
import { SettingsStore } from '../context/settings-store'

export function initSettingsStore(): void {
  getAppContext()
}

function resolveSettingsStore(): SettingsStore {
  const fromEnv = process.env.CODETASK_DATA_DIR?.trim()
  if (fromEnv) {
    return new SettingsStore(fromEnv)
  }
  return getAppContext().settings
}

export function readSettingsFile(): Record<string, unknown> {
  return resolveSettingsStore().read()
}

export function writeSettingsFile(value: Record<string, unknown>): void {
  resolveSettingsStore().write(value)
}

export function patchSettingsFile(mutator: (file: Record<string, unknown>) => void): void {
  resolveSettingsStore().patch(mutator)
}
