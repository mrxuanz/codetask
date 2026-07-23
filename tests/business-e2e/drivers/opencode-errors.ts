import type { FailureClass } from '../reports/writer'

/**
 * OpenCode SDK may surface failures on the top-level `error` field **or**
 * nested under `data.info.error` (assistant turn failed after HTTP 200).
 */
export function extractPromptFailure(promptResult: unknown): unknown | null {
  if (promptResult == null || typeof promptResult !== 'object') return null
  const root = promptResult as Record<string, unknown>
  if (isMeaningfulSdkError(root.error)) return root.error

  const data = root.data
  if (data != null && typeof data === 'object') {
    const info = (data as Record<string, unknown>).info
    if (info != null && typeof info === 'object') {
      const nested = (info as Record<string, unknown>).error
      if (isMeaningfulSdkError(nested)) return nested
    }
  }
  return null
}

/** Collect assistant text from the successful OpenCode SDK response. */
export function extractPromptText(promptResult: unknown): string {
  if (promptResult == null || typeof promptResult !== 'object') return ''
  const data = (promptResult as Record<string, unknown>).data
  if (data == null || typeof data !== 'object') return ''
  const parts = (data as Record<string, unknown>).parts
  if (!Array.isArray(parts)) return ''
  return parts
    .filter(
      (part): part is Record<string, unknown> =>
        part != null &&
        typeof part === 'object' &&
        (part as Record<string, unknown>).type === 'text' &&
        typeof (part as Record<string, unknown>).text === 'string'
    )
    .map((part) => String(part.text))
    .join('')
}

export function isMeaningfulSdkError(error: unknown): boolean {
  if (error == null || error === false) return false
  if (typeof error === 'object') {
    const keys = Object.keys(error as object)
    if (keys.length === 0) return false
  }
  if (typeof error === 'string' && error.trim() === '') return false
  return true
}

export function isRetryablePromptError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') return false
  const record = error as Record<string, unknown>
  if (record.isRetryable === true) return true
  const data = record.data
  if (
    data != null &&
    typeof data === 'object' &&
    (data as Record<string, unknown>).isRetryable === true
  ) {
    return true
  }
  return false
}

/**
 * Map OpenCode prompt / assistant errors to business-e2e FailureClass.
 *
 * - ProviderAuthError → provider_auth_missing
 * - No provider available → provider_unavailable
 * - isRetryable (exhausted) → provider_transport
 * - other assistant errors → agent_failed
 */
export function classifyOpencodePromptError(error: unknown): FailureClass {
  const text = serializePromptError(error).toLowerCase()
  const name =
    error != null &&
    typeof error === 'object' &&
    typeof (error as { name?: unknown }).name === 'string'
      ? String((error as { name: string }).name)
      : ''

  if (/providerautherror/i.test(name) || /providerautherror/i.test(text) || /\b401\b/.test(text)) {
    if (/no provider available/i.test(text)) return 'provider_unavailable'
    return 'provider_auth_missing'
  }
  if (/no provider available/i.test(text)) return 'provider_unavailable'
  if (/enoent|not found|spawn .*enoent/i.test(text)) return 'provider_unavailable'
  if (isRetryablePromptError(error)) return 'provider_transport'
  if (/econnreset|etimedout|fetch failed|socket|network/i.test(text)) return 'provider_transport'
  return 'agent_failed'
}

export function serializePromptError(error: unknown): string {
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function classifyDriverCatchError(error: unknown): FailureClass {
  const text = String(error)
  if (text.includes('timeout:') || text.includes('Timed out') || text.includes('_timeout')) {
    return 'timeout'
  }
  if (text.includes('agent_no_report:')) return 'agent_no_report'
  if (text.includes('mcp_') || text.includes('capability-report')) return 'mcp_failed'
  if (text.includes('provider_auth') || text.includes('ProviderAuthError')) {
    return 'provider_auth_missing'
  }
  if (text.includes('provider_unavailable') || text.includes('No provider available')) {
    return 'provider_unavailable'
  }
  if (
    /provider_transport|fetch failed|econnreset|econnrefused|etimedout|socket|network/i.test(text)
  ) {
    return 'provider_transport'
  }
  if (
    /ENOENT|EACCES|EPERM|not found|opencode_spawn|opencode_exited|opencode_host_config_invalid/i.test(
      text
    )
  ) {
    return 'provider_unavailable'
  }
  if (text.includes('opencode_prompt_failed:')) {
    const marker = 'opencode_prompt_failed:'
    const idx = text.indexOf(marker)
    try {
      const json = text.slice(idx + marker.length)
      return classifyOpencodePromptError(JSON.parse(json))
    } catch {
      return classifyOpencodePromptError(text)
    }
  }
  return 'agent_failed'
}
