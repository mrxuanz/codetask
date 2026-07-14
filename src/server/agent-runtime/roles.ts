export type ConversationRole =
  | 'conversation'
  | 'planner'
  | 'task-worker'
  | 'milestone-verifier'
  | 'slice-verifier'

export const OUTER_SANDBOX_ROLES: ConversationRole[] = [
  'conversation',
  'planner',
  'task-worker',
  'milestone-verifier',
  'slice-verifier'
]

export function roleRequiresOuterSandbox(role: ConversationRole): boolean {
  return OUTER_SANDBOX_ROLES.includes(role)
}

export const PLANNER_ROLE_MCP_TOOLS = [
  'register_task_context',
  'update_task_context',
  'register_plan'
] as const

export function resolveRoleMcpToolNames(role: ConversationRole): readonly string[] | undefined {
  switch (role) {
    case 'planner':
      return PLANNER_ROLE_MCP_TOOLS
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
