import type { ProviderDescriptor } from '../descriptor'

export const CLAUDE_DESCRIPTOR = Object.freeze({
  code: 'claude-code',
  aliases: ['claude', 'claude_code', 'claude-code'],
  label: 'Claude Code',
  description: 'Anthropic Claude Code CLI',
  defaultCommands: ['claude', 'claude-code'],
  childEnvironmentKeys: [],
  mcpRootKey: 'mcpServers',
  capabilities: {
    authMode: 'host-identity',
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
