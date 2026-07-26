import type { SkillProposal } from '../../application/skills/contracts'
import type { SkillDescriptor } from '../../application/skills/catalog'
import type { DraftRepo, PlanRepo } from '../../application/ports/repositories'

export const PLAN_EDITOR_SKILL_ID = 'plan-editor'
export const PLAN_EDITOR_SKILL_VERSION = '1.0.0'

export const planEditorSkillDescriptor: SkillDescriptor = {
  id: PLAN_EDITOR_SKILL_ID,
  version: PLAN_EDITOR_SKILL_VERSION,
  role: 'plan-editor'
}

export const PLAN_EDITOR_PROMPT_TEMPLATE = [
  'You are the Plan Editor skill.',
  'Propose finite PlanOperation edits only.',
  'Do not write to any repository; return a plan_operations proposal.'
].join('\n')

export type PlanEditorSkillInput = {
  readonly planId: string
  readonly instruction?: string
}

export type PlanEditorSkillForbiddenPorts = {
  readonly drafts?: DraftRepo
  readonly plans?: PlanRepo
}

/**
 * Plan Editor stub — returns an empty operations proposal (no-op).
 * Real editing arrives in a later wave; skills still must not write repos.
 */
export function runPlanEditorSkillStub(
  input: PlanEditorSkillInput,
  _forbiddenPorts?: PlanEditorSkillForbiddenPorts
): SkillProposal {
  void _forbiddenPorts
  return {
    skillId: PLAN_EDITOR_SKILL_ID,
    skillVersion: PLAN_EDITOR_SKILL_VERSION,
    kind: 'plan_operations',
    payload: {
      planId: input.planId,
      instruction: input.instruction ?? '',
      promptTemplate: PLAN_EDITOR_PROMPT_TEMPLATE,
      operations: []
    }
  }
}
