/**
 * Conversation MCP tools — ordinary chat only (architecture 03).
 * Design tools (propose_task_draft, etc.) live in Design / Planner MCP, not here.
 */
export function conversationMcpToolDefinitions(): Record<string, unknown>[] {
  return [
    {
      name: 'read_reference_attachment',
      description:
        'Read an attachment from the active user message. Use attachmentId from Reference Attachments; for images use the exposed path with Read when available.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          attachmentId: { type: 'string', description: 'Attachment ID from the current turn' }
        },
        required: ['attachmentId']
      }
    }
  ]
}

export function allConversationMcpToolNames(): string[] {
  return conversationMcpToolDefinitions().map((tool) => String(tool.name))
}
