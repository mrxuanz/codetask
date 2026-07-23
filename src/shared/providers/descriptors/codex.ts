import type { ProviderDescriptor } from '../descriptor'

export const CODEX_DESCRIPTOR = Object.freeze({
  code: 'codex',
  aliases: ['codex'],
  label: 'Codex',
  description: 'OpenAI Codex CLI',
  defaultCommands: ['codex'],
  authEnvironmentKeys: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
  childEnvironmentKeys: ['CODEX_HOME'],
  mcpRootKey: 'mcp_servers',
  capabilities: {
    authMode: 'runtime-copy',
    protocol: 'sdk',
    supportedProfiles: [
      'chat-write',
      'chat-read',
      'create-task-read',
      'planner-read',
      'task-sandbox',
      'verifier-sandbox'
    ],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)
