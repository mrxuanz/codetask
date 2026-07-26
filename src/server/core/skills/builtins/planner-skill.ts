import type { SkillProposal } from '../../application/skills/contracts'
import type { SkillDescriptor } from '../../application/skills/catalog'
import type { DraftRepo, PlanRepo } from '../../application/ports/repositories'

export const PLANNER_SKILL_ID = 'planner'
export const PLANNER_SKILL_VERSION = '1.0.0'

export const plannerSkillDescriptor: SkillDescriptor = {
  id: PLANNER_SKILL_ID,
  version: PLANNER_SKILL_VERSION,
  role: 'planner'
}

/**
 * Prompt template lives in the skill package — work layers must not assemble prompts.
 * Wave 5 uses Fake Planner (deterministic); no Provider SDK.
 */
export const PLANNER_PROMPT_TEMPLATE = [
  'You are the Planner skill.',
  'Given a confirmed draft, propose a plan tree (milestones → slices → tasks).',
  'Do not write to any repository; return a structured plan_tree proposal only.'
].join('\n')

export type PlannerSkillInput = {
  readonly draftId: string
  readonly content: string
}

/**
 * Optional forbidden ports — accepted only so boundary tests can prove the skill
 * never calls repository.save. Production callers omit this.
 */
export type PlannerSkillForbiddenPorts = {
  readonly drafts?: DraftRepo
  readonly plans?: PlanRepo
}

/**
 * Fake Planner: deterministic plan tree proposal from draft content.
 * Skills never write repos (重构.md §7).
 */
export function runFakePlanner(
  input: PlannerSkillInput,
  _forbiddenPorts?: PlannerSkillForbiddenPorts
): SkillProposal {
  void _forbiddenPorts
  const titleHint = input.content.trim().slice(0, 48) || 'Untitled requirement'
  return {
    skillId: PLANNER_SKILL_ID,
    skillVersion: PLANNER_SKILL_VERSION,
    kind: 'plan_tree',
    payload: {
      draftId: input.draftId,
      promptTemplate: PLANNER_PROMPT_TEMPLATE,
      nodes: [
        {
          id: 'ms-1',
          kind: 'milestone',
          title: 'Delivery',
          parentId: null
        },
        {
          id: 'sl-1',
          kind: 'slice',
          title: 'Core slice',
          parentId: 'ms-1'
        },
        {
          id: 'task-1',
          kind: 'task',
          title: `Implement: ${titleHint}`,
          parentId: 'sl-1',
          abilityCode: 'implement',
          successCriteria: 'Requirement satisfied and verified'
        }
      ],
      edges: []
    }
  }
}
