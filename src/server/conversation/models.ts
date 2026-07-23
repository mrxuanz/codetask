import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SupportedCoreCode } from './cores'
import { getAppConfig } from '../bootstrap'

type CursorCliConfigFile = {
  selectedModel?: {
    modelId?: string
    parameters?: Array<{ id: string; value: string }>
  }
  model?: {
    modelId?: string
  }
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function readCursorCliDefaultModelId(): string | null {
  const config = readJsonFile<CursorCliConfigFile>(join(homedir(), '.cursor', 'cli-config.json'))
  if (!config) return null
  return config.selectedModel?.modelId ?? config.model?.modelId ?? null
}

export function resolveCoreModel(
  coreCode: SupportedCoreCode,
  override?: string | null
): string | undefined {
  const explicit = override?.trim()
  if (explicit) return explicit

  const configured = getAppConfig().providers[coreCode].model?.trim()
  if (configured) return configured

  if (coreCode === 'cursorcli') {
    return readCursorCliDefaultModelId() ?? undefined
  }

  return undefined
}

export function resolveCursorAcpModelId(model?: string): string | undefined {
  return resolveCoreModel('cursorcli', model)
}
