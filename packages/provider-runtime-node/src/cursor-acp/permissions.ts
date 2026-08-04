import {
  capabilityProfileIsReadOnly,
  type AgentCapabilityProfile
} from '@server/agent-runtime/capabilities'
import { allConversationMcpToolNames } from '@server/conversation/mcp/tools'

const READ_ONLY_SYSTEM_MCP_TOOLS = new Set<string>([
  'codeteam-manager',
  ...allConversationMcpToolNames()
])

export type CursorPermissionRequestParams = {
  options: Array<{ optionId: string }>
  toolCall?: { title?: string; kind?: string }
}

export function selectAllowOption(options: Array<{ optionId: string }>): { optionId: string } {
  const allowOnce = options.find((option) => option.optionId === 'allow-once')
  if (allowOnce) return allowOnce

  const allowAlways = options.find((option) => option.optionId === 'allow-always')
  if (allowAlways) return allowAlways

  const allowAlwaysFuzzy = options.find(
    (option) => option.optionId.includes('always') && /allow|accept|approve/i.test(option.optionId)
  )
  if (allowAlwaysFuzzy) return allowAlwaysFuzzy

  return (
    options.find((option) => /allow|accept|approve/i.test(option.optionId)) ??
    options[0] ?? { optionId: 'allow-once' }
  )
}

export function selectDenyOption(
  options: Array<{ optionId: string }>
): { optionId: string } | null {
  return (
    options.find((option) => option.optionId === 'deny-always') ??
    options.find((option) => option.optionId === 'deny-once') ??
    options.find((option) => /deny|reject|cancel/i.test(option.optionId)) ??
    null
  )
}

function isAuditedSystemMcpTitle(title: string): boolean {
  const normalized = title.trim().toLowerCase()
  if (!normalized.includes('codeteam-manager')) return false

  // Cursor ACP titles arrive in a few shapes, all of which glue server + tool:
  //   "codeteam-manager read_reference_attachment"
  //   "codeteam-manager-read_reference_attachment: read_reference_attachment"
  // Require an exact audited tool name after a server separator — never infer
  // safety from prose alone.
  return [...READ_ONLY_SYSTEM_MCP_TOOLS].some((toolName) => {
    if (toolName === 'codeteam-manager') return false
    const tool = toolName.toLowerCase()
    return (
      normalized.includes(`codeteam-manager-${tool}`) ||
      normalized.includes(`codeteam-manager_${tool}`) ||
      normalized.includes(`codeteam-manager ${tool}`)
    )
  })
}

function isReadOnlyCursorTool(toolCall: CursorPermissionRequestParams['toolCall']): boolean {
  const kind = toolCall?.kind?.trim().toLowerCase()
  if (kind === 'read' || kind === 'search' || kind === 'think') return true
  if (kind !== 'other') return false
  return isAuditedSystemMcpTitle(toolCall?.title ?? '')
}

export function createCursorPermissionHandler(capabilityProfile?: AgentCapabilityProfile) {
  return async ({ params }: { params: CursorPermissionRequestParams }) => {
    if (
      capabilityProfile &&
      capabilityProfileIsReadOnly(capabilityProfile) &&
      !isReadOnlyCursorTool(params.toolCall)
    ) {
      const denied = selectDenyOption(params.options)
      if (!denied) {
        return { outcome: { outcome: 'cancelled' as const } }
      }
      return {
        outcome: {
          outcome: 'selected' as const,
          optionId: denied.optionId
        }
      }
    }
    const preferred = selectAllowOption(params.options)
    return {
      outcome: {
        outcome: 'selected' as const,
        optionId: preferred.optionId
      }
    }
  }
}
