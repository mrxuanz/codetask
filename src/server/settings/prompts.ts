import { buildChatConversationBody } from '../conversation/prompts'
import { buildPlannerSystemPrompt } from '../planner/prompts'
import {
  buildMilestoneVerifierSystemPrompt,
  buildSliceVerifierSystemPrompt
} from '../verification/prompts'
import { patchSettingsFile, readSettingsFile } from './store'

export interface PromptBodySettings {
  body: string
  useDefault: boolean
}

export interface PromptSettings {
  conversation: PromptBodySettings
  planner: PromptBodySettings
  sliceVerifier: PromptBodySettings
  milestoneVerifier: PromptBodySettings
}

export interface PromptSettingsPayload {
  settings: PromptSettings
  defaults: PromptSettings
}

const EMPTY_ENTRY: PromptBodySettings = { body: '', useDefault: true }

function defaultSettings(): PromptSettings {
  return {
    conversation: { ...EMPTY_ENTRY },
    planner: { ...EMPTY_ENTRY },
    sliceVerifier: { ...EMPTY_ENTRY },
    milestoneVerifier: { ...EMPTY_ENTRY }
  }
}

function parsePromptEntry(value: unknown): PromptBodySettings {
  if (!value || typeof value !== 'object') {
    return { ...EMPTY_ENTRY }
  }
  const object = value as Record<string, unknown>
  return {
    body: typeof object.body === 'string' ? object.body : '',
    useDefault: object.useDefault !== false
  }
}

export function buildDefaultPromptBodies(): PromptSettings {
  return {
    conversation: {
      body: buildChatConversationBody('CodeTask Conversation'),
      useDefault: true
    },
    planner: {
      body: buildPlannerSystemPrompt(),
      useDefault: true
    },
    sliceVerifier: {
      body: buildSliceVerifierSystemPrompt(),
      useDefault: true
    },
    milestoneVerifier: {
      body: buildMilestoneVerifierSystemPrompt(),
      useDefault: true
    }
  }
}

export function loadPromptSettings(): PromptSettings {
  const raw = readSettingsFile().prompts
  if (!raw || typeof raw !== 'object') {
    return defaultSettings()
  }
  const object = raw as Record<string, unknown>
  return {
    conversation: parsePromptEntry(object.conversation),
    planner: parsePromptEntry(object.planner),
    sliceVerifier: parsePromptEntry(object.sliceVerifier),
    milestoneVerifier: parsePromptEntry(object.milestoneVerifier)
  }
}

export function loadPromptSettingsPayload(): PromptSettingsPayload {
  return {
    settings: loadPromptSettings(),
    defaults: buildDefaultPromptBodies()
  }
}

export function savePromptSettings(settings: PromptSettings): PromptSettings {
  patchSettingsFile((file) => {
    file.prompts = settings
  })
  return settings
}

function resolveRolePromptBody(entry: PromptBodySettings, fallback: () => string): string {
  if (entry.useDefault) return fallback()
  const body = entry.body.trim()
  return body.length > 0 ? body : fallback()
}

export function resolveConversationPromptBody(): string | null {
  const settings = loadPromptSettings()
  if (settings.conversation.useDefault) return null
  const body = settings.conversation.body.trim()
  return body.length > 0 ? body : null
}

export function resolvePlannerPromptBody(): string {
  const settings = loadPromptSettings()
  return resolveRolePromptBody(settings.planner, buildPlannerSystemPrompt)
}

export function resolveSliceVerifierPromptBody(): string {
  const settings = loadPromptSettings()
  return resolveRolePromptBody(settings.sliceVerifier, buildSliceVerifierSystemPrompt)
}

export function resolveMilestoneVerifierPromptBody(): string {
  const settings = loadPromptSettings()
  return resolveRolePromptBody(settings.milestoneVerifier, buildMilestoneVerifierSystemPrompt)
}
