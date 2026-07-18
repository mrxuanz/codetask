import { execFileSync } from 'child_process'
import { createTurnError } from '../../shared/turn-errors.ts'

export const SUPPORTED_CORE_CODES = ['codex', 'claude-code', 'opencode', 'cursorcli'] as const
export type SupportedCoreCode = (typeof SUPPORTED_CORE_CODES)[number]

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

const CORE_META: Record<
  SupportedCoreCode,
  { label: string; description: string; commands: string[] }
> = {
  codex: {
    label: 'Codex',
    description: 'OpenAI Codex CLI',
    commands: ['codex']
  },
  'claude-code': {
    label: 'Claude Code',
    description: 'Anthropic Claude Code CLI',
    commands: ['claude', 'claude-code']
  },
  opencode: {
    label: 'OpenCode',
    description: 'OpenCode CLI',
    commands: ['opencode']
  },
  cursorcli: {
    label: 'Cursor CLI',
    description: 'Cursor Agent CLI',
    commands: ['agent', 'cursor-agent']
  }
}

export function normalizeCoreCode(value: string): SupportedCoreCode {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'claude_code') {
    return 'claude-code'
  }
  if (
    normalized === 'cursor' ||
    normalized === 'cursor-cli' ||
    normalized === 'cursor-agent' ||
    normalized === 'cursor_cli'
  ) {
    return 'cursorcli'
  }
  if ((SUPPORTED_CORE_CODES as readonly string[]).includes(normalized)) {
    return normalized as SupportedCoreCode
  }
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

function resolveCommand(command: string): string | null {
  try {
    if (process.platform === 'win32') {
      const output = execFileSync('where', [command], {
        encoding: 'utf8',
        windowsHide: true
      }).trim()
      return output.split(/\r?\n/)[0]?.trim() || null
    }
    const output = execFileSync('which', [command], { encoding: 'utf8' }).trim()
    return output || null
  } catch {
    return null
  }
}

export async function getAgentCore(code: string): Promise<AgentCoreAvailability | null> {
  let normalized: SupportedCoreCode
  try {
    normalized = normalizeCoreCode(code)
  } catch {
    return null
  }

  const meta = CORE_META[normalized]
  if (coreAvailabilityStub) {
    const stubbed = coreAvailabilityStub(normalized)
    if (stubbed !== undefined) {
      return stubbed
    }
  }
  for (const command of meta.commands) {
    const path = resolveCommand(command)
    if (path) {
      return {
        code: normalized,
        label: meta.label,
        description: meta.description,
        available: true,
        detectedCommand: command,
        launchCommand: command,
        executablePath: path
      }
    }
  }

  return {
    code: normalized,
    label: meta.label,
    description: meta.description,
    available: false,
    reason: `${meta.label} is not installed or not on PATH`,
    launchCommand: meta.commands[0]
  }
}

export async function listChatCores(): Promise<AgentCoreAvailability[]> {
  const { providerSupportsCapability } = await import('../agent-runtime/capabilities')
  const cores = await Promise.all(SUPPORTED_CORE_CODES.map((code) => getAgentCore(code)))
  return cores
    .filter((core): core is AgentCoreAvailability => core !== null)
    .map((core) => ({
      ...core,
      readOnlyCapable: providerSupportsCapability(core.code, 'chat-read')
    }))
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
