import type { SupportedCoreCode } from './cores'
import { getAppConfig } from '../bootstrap'
import {
  readCursorCliDefaultModelId,
  resolveCursorAcpModelId as resolveCursorAcpModelIdFromPackage
} from '@codetask/provider-runtime-node/cursor-models'

export { readCursorCliDefaultModelId }

export function resolveCoreModel(
  coreCode: SupportedCoreCode,
  override?: string | null
): string | undefined {
  const explicit = override?.trim()
  if (explicit) return explicit

  const configured = getAppConfig().providers[coreCode].model?.trim()
  if (configured) return configured

  if (coreCode === 'cursor') {
    return readCursorCliDefaultModelId() ?? undefined
  }

  return undefined
}

export function resolveCursorAcpModelId(model?: string): string | undefined {
  // Prefer host config via resolveCoreModel; package copy uses injected lookup.
  return resolveCoreModel('cursor', model) ?? resolveCursorAcpModelIdFromPackage(model)
}
