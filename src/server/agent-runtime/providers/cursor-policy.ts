import { join } from 'node:path'
import {
  applyTaskIdempotencyEnv,
  buildProviderChildEnv,
  buildSandboxPreparedProviderEnv,
  ensureCursorAcpRuntimeDirs,
  stripElectronInheritedEnv
} from '../env'
import { buildCursorAcpMcpServers, type CursorAcpMcpServer } from '../mcp'
import { buildCursorAcpCliArgs, resolveProviderOuterSandbox } from '../provider-policy'
import type { AgentTurnInput } from '../types'
import { resolveInputCapabilityProfile, type AgentCapabilityProfile } from '../capabilities'

export interface CursorTurnPlan {
  role: AgentTurnInput['role']
  outerSandbox: boolean
  env: Record<string, string>
  mcpServers: CursorAcpMcpServer[]
  cliArgs: string[]
  capabilityProfile: AgentCapabilityProfile
}

function buildCursorHostEnv(runtimeRoot: string, workspaceCwd?: string): Record<string, string> {
  const env = buildProviderChildEnv(runtimeRoot, { preserveHostIdentity: true })
  stripElectronInheritedEnv(env)
  // Scope Cursor project metadata / MCP approvals under the runtime root, not the host profile.
  const cursorDataDir = join(runtimeRoot, '.cursor')
  env.CURSOR_DATA_DIR = cursorDataDir
  ensureCursorAcpRuntimeDirs(runtimeRoot, workspaceCwd)
  return env
}

export function buildCursorTurnPlan(
  input: AgentTurnInput,
  options: {
    outerSandbox?: boolean | undefined
    userMcpServers?: Record<string, unknown> | undefined
  } = {}
): CursorTurnPlan {
  const outerSandbox = resolveProviderOuterSandbox(input.role, options.outerSandbox)
  const capabilityProfile = resolveInputCapabilityProfile(input)
  const env = outerSandbox
    ? buildSandboxPreparedProviderEnv()
    : buildCursorHostEnv(input.runtimeRoot, input.cwd)
  if (outerSandbox) {
    stripElectronInheritedEnv(env)
    // Outer sandbox still scopes writable Cursor data under runtimeRoot when present.
    if (input.runtimeRoot?.trim()) {
      env.CURSOR_DATA_DIR = join(input.runtimeRoot, '.cursor')
      ensureCursorAcpRuntimeDirs(input.runtimeRoot, input.cwd)
    }
  }
  applyTaskIdempotencyEnv(env, input.idempotencyKey)

  const mcpServers = buildCursorAcpMcpServers(input.mcpUrl, options.userMcpServers ?? {})
  const cliArgs = buildCursorAcpCliArgs({
    outerSandbox,
    cwd: input.cwd,
    capabilityProfile
  })

  return {
    role: input.role,
    outerSandbox,
    env,
    mcpServers,
    cliArgs,
    capabilityProfile
  }
}
