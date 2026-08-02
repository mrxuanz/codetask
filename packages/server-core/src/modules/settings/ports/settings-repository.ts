import type { SettingNamespace } from '@codetask/contracts'

export type StoredNamespace<T = unknown> = {
  value: T | null
  revision: number
  updatedAt: number
}

export type WriteNamespaceResult = {
  revision: number
  updatedAt: number
}

export interface SettingsRepository {
  readNamespace<T = unknown>(namespace: SettingNamespace): StoredNamespace<T>
  writeNamespace(
    namespace: SettingNamespace,
    value: unknown,
    expectedRevision: number
  ): WriteNamespaceResult
}
