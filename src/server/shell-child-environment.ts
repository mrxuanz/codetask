let configuredEnvironment: Record<string, string> | null = null

export function configureShellChildEnvironment(environment?: Record<string, string>): void {
  configuredEnvironment = { ...(environment ?? {}) }
}

export function getShellChildEnvironment(): Record<string, string> {
  return { ...(configuredEnvironment ?? {}) }
}

export function serializeShellChildEnvironment(): string {
  return JSON.stringify(getShellChildEnvironment())
}

export function resetShellChildEnvironment(): void {
  configuredEnvironment = null
}

/**
 * Historical fork-IPC key. Still stripped from provider children so a leftover
 * host value cannot leak; no longer read as a product/config channel.
 */
export const SERIALIZED_SHELL_CHILD_ENV = 'CODETASK_SHELL_CHILD_ENV_JSON'
