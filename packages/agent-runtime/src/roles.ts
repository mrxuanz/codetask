export type ConversationRole =
  | 'conversation'
  | 'planner'
  | 'task-worker'
  | 'milestone-verifier'
  | 'slice-verifier'

export const OUTER_SANDBOX_ROLES: ConversationRole[] = [
  'task-worker',
  'milestone-verifier',
  'slice-verifier'
]

export function roleRequiresOuterSandbox(role: ConversationRole): boolean {
  return OUTER_SANDBOX_ROLES.includes(role)
}

/**
 * System MCP tool allowlists per role.
 * Planner has no HTTP system MCP after Design cutover (PlanningApplicationPort).
 * Conversation exposes attachment read via Conversation MCP.
 */
export function resolveRoleMcpToolNames(role: ConversationRole): readonly string[] | undefined {
  switch (role) {
    case 'task-worker':
      return ['report_task_result']
    case 'slice-verifier':
      return ['complete_slice_verification']
    case 'milestone-verifier':
      return ['complete_milestone_verification']
    default:
      return undefined
  }
}

export const CLI_FULL_ACCESS_BUILTINS = [
  'Read',
  'Glob',
  'Grep',
  'LSP',
  'Bash',
  'Edit',
  'Write'
] as const
