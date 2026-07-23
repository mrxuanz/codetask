import { createTurnError } from '../../shared/turn-errors.ts'
import {
  SUPPORTED_CORE_CODES,
  normalizeProviderCode,
  type SupportedCoreCode
} from '../../shared/providers'

export { SUPPORTED_CORE_CODES, type SupportedCoreCode }

export interface AgentCoreAvailability {
  code: SupportedCoreCode
  label: string
  description: string
  available: boolean
  readOnlyCapable?: boolean | undefined
  reason?: string | null | undefined
  detectedCommand?: string | null | undefined
  launchCommand?: string | null | undefined
  executablePath?: string | null | undefined
}

export function normalizeCoreCode(value: string): SupportedCoreCode {
  const normalized = normalizeProviderCode(value)
  if (normalized) return normalized
  throw createTurnError('provider.cli_auth_failed', {
    detail: `Unsupported CLI: ${value}`
  })
}

type CoreAvailabilityStub = (code: SupportedCoreCode) => AgentCoreAvailability | null | undefined

let coreAvailabilityStub: CoreAvailabilityStub | null = null

export function setCoreAvailabilityStubForTests(stub: CoreAvailabilityStub): void {
  coreAvailabilityStub = stub
}

export function resetCoreAvailabilityStubForTests(): void {
  coreAvailabilityStub = null
}

export async function getAgentCore(code: string): Promise<AgentCoreAvailability | null> {
  let normalized: SupportedCoreCode
  try {
    normalized = normalizeCoreCode(code)
  } catch {
    return null
  }

  if (coreAvailabilityStub) {
    const stubbed = coreAvailabilityStub(normalized)
    if (stubbed !== undefined) {
      return stubbed
    }
  }

  const { getProviderRegistry } = await import('../providers/access')
  const driver = getProviderRegistry().get(normalized)
  const descriptor = driver.descriptor
  const installation = await driver.discover()

  if (installation) {
    return {
      code: normalized,
      label: descriptor.label,
      description: descriptor.description,
      available: true,
      readOnlyCapable: driver.supports('chat-read'),
      detectedCommand: installation.command,
      launchCommand: installation.command,
      executablePath: installation.resolvedPath
    }
  }

  const fallbackCommand = descriptor.defaultCommands[0]
  return {
    code: normalized,
    label: descriptor.label,
    description: descriptor.description,
    available: false,
    readOnlyCapable: driver.supports('chat-read'),
    reason: `${descriptor.label} is not installed or not on PATH`,
    launchCommand: fallbackCommand
  }
}

export async function listChatCores(): Promise<AgentCoreAvailability[]> {
  const cores = await Promise.all(SUPPORTED_CORE_CODES.map((code) => getAgentCore(code)))
  return cores.filter((core): core is AgentCoreAvailability => core !== null)
}

export async function ensureCoreAvailable(code: string): Promise<AgentCoreAvailability> {
  const core = await getAgentCore(code)
  if (!core) {
    throw createTurnError('provider.cli_auth_failed', {
      detail: `Unknown CLI: ${code}`
    })
  }
  if (!core.available) {
    throw createTurnError('provider.cli_auth_failed', {
      detail: core.reason ?? `${core.label} is not available`
    })
  }
  return core
}
