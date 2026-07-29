import { processHostEnvironmentSource } from './host-environment'

const SERIALIZED_SHELL_CHILD_ENV = 'CODETASK_SHELL_CHILD_ENV_JSON'

let configuredEnvironment: Record<string, string> | null = null

function parseSerializedEnvironment(value: string | undefined): Record<string, string> {
  if (!value) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] =>
          typeof entry[1] === 'string' && entry[0].trim().length > 0
      )
    )
  } catch {
    return {}
  }
}

export function configureShellChildEnvironment(environment?: Record<string, string>): void {
  configuredEnvironment = { ...(environment ?? {}) }
}

export function getShellChildEnvironment(): Record<string, string> {
  return {
    ...(configuredEnvironment ??
      parseSerializedEnvironment(processHostEnvironmentSource.snapshot()[SERIALIZED_SHELL_CHILD_ENV]))
  }
}

export function serializeShellChildEnvironment(): string {
  return JSON.stringify(getShellChildEnvironment())
}

export function resetShellChildEnvironment(): void {
  configuredEnvironment = null
}

export { SERIALIZED_SHELL_CHILD_ENV }
