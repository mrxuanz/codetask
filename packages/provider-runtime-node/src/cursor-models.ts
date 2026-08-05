import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SupportedCoreCode } from './spec/codes.ts'

type CursorCliConfigFile = {
  selectedModel?: {
    modelId?: string
    parameters?: Array<{ id: string; value: string }>
  }
  model?: {
    modelId?: string
  }
}

type ConfiguredModelProvider = (coreCode: SupportedCoreCode) => string | undefined

let configuredModelProvider: ConfiguredModelProvider | null = null

/** Host wires app config model lookup during bootstrap. */
export function configureCursorModels(getConfiguredModel: ConfiguredModelProvider): void {
  configuredModelProvider = getConfiguredModel
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

  const configured = configuredModelProvider?.(coreCode)?.trim()
  if (configured) return configured

  if (coreCode === 'cursor') {
    return readCursorCliDefaultModelId() ?? undefined
  }

  return undefined
}

export function resolveCursorAcpModelId(model?: string): string | undefined {
  return resolveCoreModel('cursor', model)
}
