import { normalizeTurnError } from '../../shared/turn-errors.ts'

export function isExecutionInfraNotReadyError(error: unknown): boolean {
  const turnError = normalizeTurnError(error)
  if (turnError.code === 'sandbox.required') return true

  const haystack = [
    turnError.message,
    turnError.detail,
    error instanceof Error ? error.message : String(error)
  ]
    .filter(Boolean)
    .join(' ')

  return (
    haystack.includes('MCP backend port is not initialized') ||
    haystack.includes('supervisor not ready') ||
    haystack.includes('Sandbox is not ready')
  )
}
