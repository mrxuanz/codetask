import type { ConversationMessageDto } from './types'

const DEFAULT_HISTORY_LIMIT = 30
const MAX_HISTORY_CHARS = 32_000

const CORE_SHORT_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  opencode: 'OpenCode',
  cursor: 'Cursor'
}

const ALWAYS_SEED_HISTORY_CORES = new Set(['cursor', 'opencode'])

function isHistoryEligible(message: ConversationMessageDto): boolean {
  if (message.role !== 'user' && message.role !== 'assistant') {
    return false
  }
  return message.kind === 'text'
}

function formatHistoryMessage(message: ConversationMessageDto): string | null {
  const content = message.content.trim()
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

export function shouldSeedConversationHistory(
  runtimeSessionId: string | null | undefined,
  currentCoreCode: string,
  priorMessages: ConversationMessageDto[],
  options?: {
    excludeMessageId?: string
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
  }
): string | null {
  const limit = options?.limit ?? DEFAULT_HISTORY_LIMIT

  const scoped = messages
    .filter((message) => message.id !== options?.excludeMessageId)
    .filter(isHistoryEligible)

  const lines = scoped
    .slice(-limit)
    .map(formatHistoryMessage)
    .filter((line): line is string => Boolean(line))

  if (lines.length === 0) {
    return null
  }

  let body = lines.join('\n\n')
  if (body.length > MAX_HISTORY_CHARS) {
    body = `…(earlier messages truncated)\n\n${body.slice(-MAX_HISTORY_CHARS)}`
  }

  return [
    '## Prior conversation',
    'These messages were exchanged earlier in this thread (possibly with another CLI).',
    'Use them as established context for the current turn.',
    '',
    body
  ].join('\n')
}

export function augmentPromptWithHistory(prompt: string, historyBlock: string | null): string {
  if (!historyBlock) {
    return prompt
  }
  return `${historyBlock}\n\n---\n\n## Current turn\n\n${prompt}`
}
