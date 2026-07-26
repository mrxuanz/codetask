/**
 * Builtin skill versioning layout (Wave 5 / 重构.md §7.1):
 *
 *   src/server/core/skills/builtins/
 *     planner-skill.ts      — Fake Planner (deterministic plan_tree)
 *     plan-editor-skill.ts  — stub plan_operations proposal
 *
 * Each builtin exports:
 *   - `*SkillDescriptor` { id, version, role }
 *   - prompt template constant (prompt generation only inside skills)
 *   - pure `run*` that returns SkillProposal (never repository writes)
 *
 * Catalog registration: `BuiltinSkillCatalog` in application/skills/catalog.ts.
 */
export {
  PLANNER_SKILL_ID,
  PLANNER_SKILL_VERSION,
  PLANNER_PROMPT_TEMPLATE,
  plannerSkillDescriptor,
  runFakePlanner,
  type PlannerSkillInput,
  type PlannerSkillForbiddenPorts
} from './planner-skill'

export {
  PLAN_EDITOR_SKILL_ID,
  PLAN_EDITOR_SKILL_VERSION,
  PLAN_EDITOR_PROMPT_TEMPLATE,
  planEditorSkillDescriptor,
  runPlanEditorSkillStub,
  type PlanEditorSkillInput,
  type PlanEditorSkillForbiddenPorts
} from './plan-editor-skill'
