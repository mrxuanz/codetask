import { getAppContext } from '../bootstrap'
import { SettingsStore } from '../context/settings-store'

export function initSettingsStore(): void {
  getAppContext()
}

function resolveSettingsStore(): SettingsStore {
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
