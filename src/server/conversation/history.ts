import type { ConversationMessageDto } from './types'
import type { WizardPhase } from '../wizard/types'
import { WIZARD_PHASE_COLLECT } from '../wizard/types'

const DEFAULT_HISTORY_LIMIT = 30
const MAX_HISTORY_CHARS = 32_000

const CORE_SHORT_LABELS: Record<string, string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
  opencode: 'OpenCode',
  cursorcli: 'Cursor'
}

const ALWAYS_SEED_HISTORY_CORES = new Set(['cursorcli', 'opencode'])

function isHistoryEligible(message: ConversationMessageDto): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false
  }
  return message.kind === 'text' || message.kind === 'task-launch-draft'
}

function formatHistoryMessage(message: ConversationMessageDto): string | null {
  let content = message.content.trim()
  if (message.kind === 'task-launch-draft') {
    content = `[Task launch draft] ${content}`
  }
  if (!content) {
    return null
  }

  const role = message.role === 'user' ? 'User' : 'Assistant'
  const coreLabel = message.coreCode
    ? (CORE_SHORT_LABELS[message.coreCode] ?? message.coreCode)
    : null
  const coreNote = coreLabel ? ` (${coreLabel})` : ''
  return `**${role}${coreNote}:** ${content}`
}

export function findLatestHandoff(
  messages: ConversationMessageDto[]
): ConversationMessageDto | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].kind === 'wizard-handoff') return messages[i]
  }
  return null
}

function filterMessagesForWizardPhase(
  messages: ConversationMessageDto[],
  wizardPhase: WizardPhase
): ConversationMessageDto[] {
  return messages.filter((message) => {
    if (message.kind === 'wizard-handoff') return false
    if (!message.wizardPhase) return wizardPhase === WIZARD_PHASE_COLLECT
    return message.wizardPhase === wizardPhase
  })
}

export function buildHandoffHistoryBlock(handoff: ConversationMessageDto | null): string | null {
  if (!handoff) return null
  const payload = handoff.payload as { requirementsSummary?: string; reason?: string } | undefined
  const lines = [
    '## Phase handoff',
    handoff.content.trim(),
    payload?.reason ? `Rollback reason: ${payload.reason}` : ''
  ].filter(Boolean)
  return lines.join('\n\n')
}

export function shouldSeedConversationHistory(
  runtimeSessionId: string | null | undefined,
  currentCoreCode: string,
  priorMessages: ConversationMessageDto[],
  options?: {
    excludeMessageId?: string
    wizardPhase?: WizardPhase
    createTaskMode?: boolean
  }
): boolean {
  const prior = priorMessages
    .filter((message) => message.id !== options?.excludeMessageId)
    .filter(isHistoryEligible)

  if (prior.length === 0) {
    return false
  }

  if (ALWAYS_SEED_HISTORY_CORES.has(currentCoreCode)) {
    return true
  }

  if (options?.createTaskMode) {
    if (!runtimeSessionId) return true
    const hasCurrentCoreMessages = prior.some((message) => message.coreCode === currentCoreCode)
    if (!hasCurrentCoreMessages) return true
    const last = prior.at(-1)
    return Boolean(last && last.coreCode !== currentCoreCode)
  }

  if (!runtimeSessionId) {
    return true
  }

  const hasCurrentCoreMessages = prior.some((message) => message.coreCode === currentCoreCode)
  if (!hasCurrentCoreMessages) {
    return true
  }

  const last = prior.at(-1)
  return Boolean(last && last.coreCode !== currentCoreCode)
}

export function buildConversationHistoryBlock(
  messages: ConversationMessageDto[],
  options?: {
    excludeMessageId?: string
    limit?: number
    wizardPhase?: WizardPhase
    createTaskMode?: boolean
  }
): string | null {
  const limit = options?.limit ?? DEFAULT_HISTORY_LIMIT
  const handoff = findLatestHandoff(messages)
  const handoffBlock = buildHandoffHistoryBlock(handoff)

  let scoped = messages.filter((message) => message.id !== options?.excludeMessageId)

  if (options?.createTaskMode && options.wizardPhase) {
    if (handoff) {
      const handoffAt = handoff.createdAt
      scoped = scoped.filter(
        (message) =>
          message.createdAt >= handoffAt &&
          (message.wizardPhase === options.wizardPhase || !message.wizardPhase)
      )
    } else {
      scoped = filterMessagesForWizardPhase(scoped, options.wizardPhase)
    }
    scoped = scoped.filter(isHistoryEligible)
  } else {
    scoped = scoped.filter(isHistoryEligible)
  }

  const lines = scoped
    .slice(-limit)
    .map(formatHistoryMessage)
    .filter((line): line is string => Boolean(line))

  if (lines.length === 0 && !handoffBlock) {
    return null
  }

  let body = lines.join('\n\n')
  if (body.length > MAX_HISTORY_CHARS) {
    body = `…(earlier messages truncated)\n\n${body.slice(-MAX_HISTORY_CHARS)}`
  }

  const sections: string[] = []
  if (handoffBlock && options?.createTaskMode) {
    sections.push(handoffBlock)
  }
  if (body) {
    sections.push(
      [
        '## Prior conversation',
        options?.createTaskMode
          ? 'Messages from the current wizard phase only.'
          : 'These messages were exchanged earlier in this thread (possibly with another CLI).',
        'Use them as established context for the current turn.',
        '',
        body
      ].join('\n')
    )
  }

  return sections.join('\n\n')
}

export function isFirstWizardPhaseTurn(
  messages: ConversationMessageDto[],
  options: {
    excludeMessageId?: string
    wizardPhase: WizardPhase
  }
): boolean {
  const prior = messages
    .filter((message) => message.id !== options.excludeMessageId)
    .filter(isHistoryEligible)
  const scoped = filterMessagesForWizardPhase(prior, options.wizardPhase)
  return scoped.length === 0
}

export function augmentPromptWithHistory(prompt: string, historyBlock: string | null): string {
  if (!historyBlock) {
    return prompt
  }
  return `${historyBlock}\n\n---\n\n## Current turn\n\n${prompt}`
}
