import type { SupportedCoreCode } from '../conversation/cores'
import {
  CODETEAM_MANAGER_MCP_SERVER,
  MCP_HTTP_ACCEPT_HEADER_VALUE
} from '../conversation/draft/types'
import { allCreateTaskMcpToolNames } from '../wizard/tools'

export function buildHttpMcpServerConfig(url: string): {
  type: 'http'
  url: string
  headers?: Record<string, string>
} {
  return {
    type: 'http',
    url,
    headers: {
      Accept: MCP_HTTP_ACCEPT_HEADER_VALUE
    }
  }
}

function buildCodexMcpToolApprovals(
  toolNames?: readonly string[]
): Record<string, { approval_mode: 'approve' }> {
  const names = toolNames ?? allCreateTaskMcpToolNames()
  return Object.fromEntries(names.map((name) => [name, { approval_mode: 'approve' as const }]))
}

type CodexMcpServerEntry =
  | {
      url: string
      http_headers: Record<string, string>
      required: true
      default_tools_approval_mode: 'approve'
      tools: Record<string, { approval_mode: 'approve' }>
    }
  | {
      command: string
      args?: string[]
      env?: Record<string, string>
    }

export function buildCodexMcpConfig(
  url: string,
  toolNames?: readonly string[],
  userMcpServers: Record<string, unknown> = {}
): {
  mcp_servers: Record<string, CodexMcpServerEntry | unknown>
} {
  return {
    mcp_servers: {
      ...userMcpServers,
      [CODETEAM_MANAGER_MCP_SERVER]: {
        url,
        http_headers: {
          Accept: MCP_HTTP_ACCEPT_HEADER_VALUE
        },
        required: true,
        default_tools_approval_mode: 'approve',
        tools: buildCodexMcpToolApprovals(toolNames)
      }
    }
  }
}

export type CodexSdkConfig = ReturnType<typeof buildCodexMcpConfig> & {
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access'
  approval_policy?: 'never' | 'on-request' | 'on-failure' | 'untrusted'
  sandbox_workspace_write?: {
    network_access?: boolean
  }
}

export function buildOuterSandboxCodexConfigOverrides(): Pick<
  CodexSdkConfig,
  'sandbox_mode' | 'approval_policy' | 'sandbox_workspace_write'
> {
  return {
    sandbox_mode: 'danger-full-access',
    approval_policy: 'never',
    sandbox_workspace_write: { network_access: true }
  }
}

export function buildCodexSdkConfig(input: {
  mcpUrl?: string | undefined
  outerSandbox?: boolean | undefined
  mcpToolNames?: readonly string[] | undefined
  userMcpServers?: Record<string, unknown> | undefined
}): CodexSdkConfig | undefined {
  const config: CodexSdkConfig = {} as CodexSdkConfig
  const userMcpServers = input.userMcpServers ?? {}

  if (input.mcpUrl) {
    Object.assign(config, buildCodexMcpConfig(input.mcpUrl, input.mcpToolNames, userMcpServers))
  } else if (Object.keys(userMcpServers).length > 0) {
    config.mcp_servers = userMcpServers
  }

  if (input.outerSandbox) {
    Object.assign(config, buildOuterSandboxCodexConfigOverrides())
  }

  const hasMcp = Boolean(config.mcp_servers && Object.keys(config.mcp_servers).length > 0)
  const hasOuterOverrides = Boolean(input.outerSandbox)
  if (!hasMcp && !hasOuterOverrides) return undefined
  return config
}

type ClaudeMcpServerConfig =
  | ReturnType<typeof buildHttpMcpServerConfig>
  | {
      command: string
      args?: string[]
      env?: Record<string, string>
    }

export function buildClaudeMcpServers(
  url?: string,
  userMcpServers: Record<string, unknown> = {}
): Record<string, ClaudeMcpServerConfig | unknown> {
  const merged: Record<string, ClaudeMcpServerConfig | unknown> = { ...userMcpServers }
  if (url) {
    merged[CODETEAM_MANAGER_MCP_SERVER] = buildHttpMcpServerConfig(url)
  }
  return merged
}

type OpencodeMcpServerConfig =
  | {
      type: 'remote'
      url: string
      enabled: true
      headers: Record<string, string>
    }
  | {
      type: 'local'
      command: string[]
      enabled: true
      environment?: Record<string, string>
    }

export function buildOpencodeMcpServers(
  url?: string,
  userMcpServers: Record<string, unknown> = {}
): Record<string, OpencodeMcpServerConfig | unknown> {
  const merged: Record<string, OpencodeMcpServerConfig | unknown> = { ...userMcpServers }
  if (url) {
    merged[CODETEAM_MANAGER_MCP_SERVER] = {
      type: 'remote',
      url,
      enabled: true,
      headers: {
        Accept: MCP_HTTP_ACCEPT_HEADER_VALUE
      }
    }
  }
  return merged
}

export type CursorAcpMcpServer = {
  name: string
  type: 'http' | 'stdio'
  url?: string
  command?: string
  args?: string[] | undefined
  env?: Record<string, string> | undefined
  headers?: Array<{ name: string; value: string }> | undefined
}

function headersFromUnknown(value: unknown): Array<{ name: string; value: string }> | undefined {
  if (!value || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    const entries = value
      .map((item) => {
        if (!item || typeof item !== 'object') return null
        const record = item as Record<string, unknown>
        if (typeof record.name !== 'string' || typeof record.value !== 'string') return null
        return { name: record.name, value: record.value }
      })
      .filter((item): item is { name: string; value: string } => item !== null)
    return entries.length > 0 ? entries : undefined
  }
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string'
  ) as Array<[string, string]>
  return entries.length > 0 ? entries.map(([name, val]) => ({ name, value: val })) : undefined
}

function envRecordFromUnknown(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([, v]) => typeof v === 'string'
  ) as Array<[string, string]>
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
}

export function cursorMcpServersFromNativeMap(map: Record<string, unknown>): CursorAcpMcpServer[] {
  return Object.entries(map).map(([name, raw]) => {
    const server = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    if (typeof server.url === 'string') {
      return {
        name,
        type: 'http' as const,
        url: server.url,
        headers: headersFromUnknown(server.headers)
      }
    }
    return {
      name,
      type: 'stdio' as const,
      command: typeof server.command === 'string' ? server.command : '',
      args: Array.isArray(server.args)
        ? server.args.filter((item): item is string => typeof item === 'string')
        : undefined,
      env: envRecordFromUnknown(server.env)
    }
  })
}

export function buildCursorAcpMcpServers(
  url?: string,
  userMcpServers: Record<string, unknown> = {}
): CursorAcpMcpServer[] {
  const merged = cursorMcpServersFromNativeMap(userMcpServers)
  if (url) {
    merged.push({
      name: CODETEAM_MANAGER_MCP_SERVER,
      type: 'http',
      url,
      headers: [{ name: 'Accept', value: MCP_HTTP_ACCEPT_HEADER_VALUE }]
    })
  }
  return merged
}

export function listMergedMcpServerNames(
  systemMcpUrl: string | undefined,
  userMcpServers: Record<string, unknown>
): string[] {
  const names = Object.keys(userMcpServers)
  if (systemMcpUrl) names.push(CODETEAM_MANAGER_MCP_SERVER)
  return names
}

export function cliMcpRootKey(coreCode: SupportedCoreCode): string {
  const keys: Record<SupportedCoreCode, string> = {
    'claude-code': 'mcpServers',
    codex: 'mcp_servers',
    cursorcli: 'mcpServers',
    opencode: 'mcp'
  }
  return keys[coreCode]
}
