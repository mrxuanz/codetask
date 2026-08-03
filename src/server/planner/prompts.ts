import { buildPlannerSystemPrompt as buildDesignPlannerSystemPrompt } from '@codetask/server-core'

/**
 * Default Design Planner system prompt (Settings `agent_prompts.planner`).
 * Delegates to Design module MCP protocol prompt — register_plan_outline →
 * register_task_context → finalize_plan.
 */
export function buildPlannerSystemPrompt(): string {
  return buildDesignPlannerSystemPrompt()
}
