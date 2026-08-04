import type { ProviderDescriptor } from '../descriptor'

export const CURSOR_DESCRIPTOR = Object.freeze({
  code: 'cursor',
  aliases: ['cursor', 'cursor-cli', 'cursor-agent', 'cursor_cli', 'cursorcli'],
  label: 'Cursor CLI',
  description: 'Cursor Agent CLI',
  defaultCommands: ['agent', 'cursor-agent'],
  authEnvironmentKeys: ['CURSOR_API_KEY'],
  childEnvironmentKeys: ['CURSOR_CONFIG_DIR'],
  mcpRootKey: 'mcpServers',
  capabilities: {
    authMode: 'host-identity',
    protocol: 'acp',
    supportedProfiles: [
      'chat-write',
      'chat-read',
      'planner-read',
      'task-sandbox',
      'verifier-sandbox'
    ],
    reuse: ['one-shot', 'conversation-scoped'],
    supportsIsolatedHome: false
  }
} satisfies ProviderDescriptor)
