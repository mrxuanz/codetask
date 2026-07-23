import type { ProviderDescriptor } from '../descriptor'

export const OPENCODE_DESCRIPTOR = Object.freeze({
  code: 'opencode',
  aliases: ['opencode'],
  label: 'OpenCode',
  description: 'OpenCode CLI',
  defaultCommands: ['opencode'],
  authEnvironmentKeys: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENCODE_API_KEY'],
  childEnvironmentKeys: [
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'OPENCODE_CONFIG_CONTENT'
  ],
  mcpRootKey: 'mcp',
  capabilities: {
    authMode: 'runtime-copy',
    protocol: 'local-server',
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
