/** Task-worker MCP tools — report_task_result is the required completion signal. */
export function taskMcpToolDefinitions(): Record<string, unknown>[] {
  return [
    {
      name: 'report_task_result',
      description:
        'Submit the final task result with structured evidence. This is the required completion signal.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['completed', 'blocked', 'failed'] },
          summary: { type: 'string', description: 'What was done or why the task stopped' },
          changedFiles: {
            type: 'array',
            items: { type: 'string' },
            description: 'Workspace-relative paths changed (empty array if none)'
          },
          evidence: {
            type: 'array',
            items: { type: 'string' },
            description: 'Concrete evidence items supporting the outcome'
          },
          validation: {
            type: 'object',
            properties: {
              ran: { type: 'boolean' },
              command: { type: 'string' },
              outcome: {
                type: 'string',
                enum: ['passed', 'failed', 'skipped', 'not-applicable']
              },
              notes: { type: 'string' }
            },
            required: ['ran', 'outcome']
          },
          blockers: {
            type: 'array',
            items: { type: 'string' },
            description: 'Required when status is blocked'
          },
          blockerKind: {
            type: 'string',
            enum: ['infra', 'dependency-prep', 'dependency-human', 'decision', 'implementation'],
            description:
              'Optional classifier hint: infra=tool/runtime failure; dependency-prep=missing workspace artifact you cannot create; dependency-human=needs operator (API key, login, reference); decision=ambiguous requirements; implementation=code cannot be completed'
          }
        },
        required: ['status', 'summary', 'changedFiles', 'evidence', 'validation']
      }
    }
  ]
}

export function allTaskMcpToolNames(): string[] {
  return taskMcpToolDefinitions().map((tool) => String(tool.name))
}
