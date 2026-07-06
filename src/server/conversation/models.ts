import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import type { SupportedCoreCode } from './cores'

const CORE_MODEL_ENV: Record<SupportedCoreCode, string> = {
  codex: 'CODETASK_MODEL_CODEX',
  'claude-code': 'CODETASK_MODEL_CLAUDE',
  opencode: 'CODETASK_MODEL_OPENCODE',
  cursorcli: 'CODETASK_MODEL_CURSOR'
}

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

  const fromEnv = process.env[CORE_MODEL_ENV[coreCode]]?.trim()
  if (fromEnv) return fromEnv

  if (coreCode === 'cursorcli') {
    const cursorDefault = process.env.CURSOR_DEFAULT_MODEL?.trim()
    if (cursorDefault) return cursorDefault
    return readCursorCliDefaultModelId() ?? undefined
  }

  return undefined
}

export function resolveCursorAcpModelId(model?: string): string | undefined {
  return resolveCoreModel('cursorcli', model)
}
