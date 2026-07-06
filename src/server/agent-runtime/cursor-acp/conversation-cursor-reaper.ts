import {
  listConversationCursorBindings,
  markConversationCursorBindingStopped,
  resetConversationCursorDirectoryForTests
} from './conversation-cursor-directory'
import {
  getCursorProviderRuntimeRegistry,
  resetCursorProviderRuntimeRegistryForTests
} from './runtime-registry'
import { closeCursorRuntimeScope } from './stream-session-turn'

export const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export interface ConversationCursorReaperOptions {
  inactivityThresholdMs?: number
  isThreadInflight?: (threadId: string) => boolean
}

let defaultIsThreadInflight: ((threadId: string) => boolean) | null = null

export function configureConversationCursorReaper(input: {
  isThreadInflight: (threadId: string) => boolean
}): void {
  defaultIsThreadInflight = input.isThreadInflight
}

function resolveIsThreadInflight(
  override?: (threadId: string) => boolean
): (threadId: string) => boolean {
  if (override) return override
  if (defaultIsThreadInflight) return defaultIsThreadInflight
  return () => false
}

export async function sweepConversationCursorSessions(
  options?: ConversationCursorReaperOptions
): Promise<number> {
  const threshold = Math.max(1, options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS)
  const isThreadInflight = resolveIsThreadInflight(options?.isThreadInflight)
  const registry = getCursorProviderRuntimeRegistry()
  const now = Date.now()
  let reapedCount = 0

  for (const binding of listConversationCursorBindings()) {
    if (binding.status === 'stopped') continue

    const idleDurationMs = now - binding.lastSeenAt
    if (idleDurationMs < threshold) continue

    if (isThreadInflight(binding.threadId)) {
      continue
    }

    if (registry.isPromptInFlightForScope(binding.scopeId)) {
      continue
    }

    try {
      await closeCursorRuntimeScope(binding.scopeId)
      markConversationCursorBindingStopped(binding.scopeId)
      reapedCount += 1
      console.info('[cursor-acp] conversation session reaped', {
        scopeId: binding.scopeId,
        threadId: binding.threadId,
        kind: binding.kind,
        idleDurationMs,
        reason: 'inactivity_threshold'
      })
    } catch (error) {
      console.warn('[cursor-acp] conversation session reaper stop failed', {
        scopeId: binding.scopeId,
        threadId: binding.threadId,
        idleDurationMs,
        error
      })
    }
  }

  if (reapedCount > 0) {
    console.info('[cursor-acp] conversation session reaper sweep complete', {
      reapedCount,
      totalBindings: listConversationCursorBindings().length
    })
  }

  return reapedCount
}

let reaperTimer: ReturnType<typeof setInterval> | null = null

export function startConversationCursorReaper(
  options?: ConversationCursorReaperOptions & { sweepIntervalMs?: number }
): void {
  if (reaperTimer) return

  const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS)
  const inactivityThresholdMs = options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS

  void sweepConversationCursorSessions({
    inactivityThresholdMs,
    isThreadInflight: options?.isThreadInflight
  }).catch((error) => {
    console.warn('[cursor-acp] conversation session reaper initial sweep failed', error)
  })

  reaperTimer = setInterval(() => {
    void sweepConversationCursorSessions({
      inactivityThresholdMs,
      isThreadInflight: options?.isThreadInflight
    }).catch((error) => {
      console.warn('[cursor-acp] conversation session reaper sweep failed', error)
    })
  }, sweepIntervalMs)
  reaperTimer.unref?.()

  console.info('[cursor-acp] conversation session reaper started', {
    inactivityThresholdMs,
    sweepIntervalMs
  })
}

export function stopConversationCursorReaperForTests(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer)
    reaperTimer = null
  }
  defaultIsThreadInflight = null
  resetConversationCursorDirectoryForTests()
  resetCursorProviderRuntimeRegistryForTests()
}
