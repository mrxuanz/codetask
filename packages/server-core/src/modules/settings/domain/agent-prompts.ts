import type { AgentPromptSettings, PromptEntry } from '@codetask/contracts'
import { SettingsError } from './settings-errors.ts'

export const MAX_PROMPT_BODY_LENGTH = 100_000

const PROMPT_ROLES = ['conversation', 'planner', 'sliceVerifier', 'milestoneVerifier'] as const

type PromptRole = (typeof PROMPT_ROLES)[number]

function defaultPromptEntry(): PromptEntry {
  return { mode: 'default', body: '' }
}

export function defaultAgentPromptSettings(): AgentPromptSettings {
  return {
    conversation: defaultPromptEntry(),
    planner: defaultPromptEntry(),
    sliceVerifier: defaultPromptEntry(),
    milestoneVerifier: defaultPromptEntry()
  }
}

function parsePromptEntry(value: unknown, path: string): PromptEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return defaultPromptEntry()
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (key !== 'mode' && key !== 'body') {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown field ${path}.${key}`)
    }
  }
  const mode = record.mode === 'custom' ? 'custom' : 'default'
  const body = typeof record.body === 'string' ? record.body : ''
  return { mode, body }
}

export function parseAgentPromptSettings(value: unknown): AgentPromptSettings {
  const defaults = defaultAgentPromptSettings()
  if (value === undefined || value === null) return defaults
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw SettingsError.badRequest('settings.invalid_payload', 'agent_prompts must be an object')
  }
  const record = value as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(PROMPT_ROLES as readonly string[]).includes(key)) {
      throw SettingsError.badRequest('settings.invalid_payload', `Unknown field: ${key}`)
    }
  }
  const parsed = {} as AgentPromptSettings
  for (const role of PROMPT_ROLES) {
    parsed[role] = parsePromptEntry(record[role], role)
  }
  return parsed
}

export function normalizeAgentPromptSettings(value: unknown): AgentPromptSettings {
  const parsed = parseAgentPromptSettings(value)
  const normalized = {} as AgentPromptSettings
  for (const role of PROMPT_ROLES) {
    const entry = parsed[role]
    if (entry.mode === 'default') {
      normalized[role] = { mode: 'default', body: '' }
      continue
    }
    normalized[role] = { mode: 'custom', body: entry.body }
  }
  return normalized
}

export function validateAgentPromptSettings(value: AgentPromptSettings): AgentPromptSettings {
  for (const role of PROMPT_ROLES) {
    const entry = value[role as PromptRole]
    if (entry.mode === 'custom') {
      if (!entry.body.trim()) {
        throw SettingsError.badRequest(
          'settings.prompt_empty',
          `${role} custom prompt body cannot be empty`
        )
      }
      if (entry.body.length > MAX_PROMPT_BODY_LENGTH) {
        throw SettingsError.badRequest(
          'settings.prompt_too_large',
          `${role} prompt exceeds ${MAX_PROMPT_BODY_LENGTH} characters`
        )
      }
    } else if (entry.body !== '') {
      throw SettingsError.badRequest(
        'settings.invalid_payload',
        `${role} body must be empty when mode is default`
      )
    }
  }
  return value
}
