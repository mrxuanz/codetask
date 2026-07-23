import type { ProviderDescriptor } from '../descriptor'

export const CLAUDE_DESCRIPTOR = Object.freeze({
  code: 'claude-code',
  aliases: ['claude', 'claude_code', 'claude-code'],
  label: 'Claude Code',
  description: 'Anthropic Claude Code CLI',
  defaultCommands: ['claude', 'claude-code'],
  authEnvironmentKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  childEnvironmentKeys: [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_SMALL_FAST_MODEL'
  ],
  mcpRootKey: 'mcpServers',
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
