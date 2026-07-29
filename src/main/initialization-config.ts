import { existsSync, readFileSync } from 'fs'
import { dirname, isAbsolute, join, resolve } from 'path'

export const INITIALIZATION_CONFIG_FILENAME = 'codetask-data.json'

export interface InitializationConfig {
  /** CodeTask data root. Relative paths are resolved from codetask-data.json. */
  dbPath: string
}

export function resolveInitializationConfigPath(input: {
  isPackaged: boolean
  executablePath: string
  developmentRoot: string
}): string {
  const configRoot = input.isPackaged
    ? dirname(resolve(input.executablePath))
    : resolve(input.developmentRoot)
  return join(configRoot, INITIALIZATION_CONFIG_FILENAME)
}

export function readInitializationConfig(configPath: string): InitializationConfig {
  const absoluteConfigPath = resolve(configPath)
  if (!existsSync(absoluteConfigPath)) {
    throw new Error(`Initialization config not found: ${absoluteConfigPath}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(absoluteConfigPath, 'utf8'))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Initialization config is not valid JSON: ${absoluteConfigPath} (${message})`)
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Initialization config must be a JSON object: ${absoluteConfigPath}`)
  }

  const dbPath = (raw as Record<string, unknown>).dbPath
  if (typeof dbPath !== 'string' || !dbPath.trim()) {
    throw new Error(
      `Initialization config dbPath must be a non-empty string: ${absoluteConfigPath}`
    )
  }

  const configuredPath = dbPath.trim()
  return {
    dbPath: isAbsolute(configuredPath)
      ? resolve(configuredPath)
      : resolve(dirname(absoluteConfigPath), configuredPath)
  }
}
