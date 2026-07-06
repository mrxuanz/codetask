import {
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv,
  stripElectronInheritedEnv
} from '../env'
import { buildCursorAcpMcpServers, type CursorAcpMcpServer } from '../mcp'
import { buildCursorAcpCliArgs, resolveProviderOuterSandbox } from '../provider-policy'
import type { AgentTurnInput } from '../types'

export interface CursorTurnPlan {
  role: AgentTurnInput['role']
  outerSandbox: boolean
  env: Record<string, string>
  mcpServers: CursorAcpMcpServer[]
  cliArgs: string[]
}

function buildCursorHostEnv(runtimeRoot: string): Record<string, string> {
  const env = buildProviderChildEnv(runtimeRoot, { preserveHostIdentity: true })
  stripElectronInheritedEnv(env)
  return env
}

export function buildCursorTurnPlan(
  input: AgentTurnInput,
  options: { outerSandbox?: boolean; userMcpServers?: Record<string, unknown> } = {}
): CursorTurnPlan {
  const outerSandbox = resolveProviderOuterSandbox(input.role, options.outerSandbox)
  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildCursorHostEnv(input.runtimeRoot)
  if (outerSandbox) stripElectronInheritedEnv(env)

  const mcpServers = buildCursorAcpMcpServers(input.mcpUrl, options.userMcpServers ?? {})
  const cliArgs = buildCursorAcpCliArgs({ outerSandbox, cwd: input.cwd })

  return {
    role: input.role,
    outerSandbox,
    env,
    mcpServers,
    cliArgs
  }
}
