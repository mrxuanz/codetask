import type {
  BusinessSkillDefinition,
  BusinessSkillsSettings,
  BusinessSkillWorkflow
} from '@shared/contracts/business-skills'
import { BUSINESS_SKILL_WORKFLOWS } from '@shared/contracts/business-skills'
import type { BusinessSkillSnapshot } from '@shared/contracts/plan'
import { getAppContext } from '../bootstrap'

const DEFAULT_SKILLS: BusinessSkillDefinition[] = [
  {
    id: 'conversation-read-only',
    name: 'Read-only conversation',
    description: 'Inspect and explain the task workspace without mutating it.',
    instructions:
      'Treat the bound workspace as read-only. Explain findings and proposed changes, but do not edit files or run mutating commands.',
    enabled: true
  },
  {
    id: 'draft-requirements',
    name: 'Draft requirements',
    description: 'Turn the conversation into a precise requirements contract.',
    instructions:
      'Capture the user goal, boundaries, assumptions, acceptance criteria, references, and workstream abilities. Keep the draft implementation-neutral and do not modify the workspace.',
    enabled: true
  },
  {
    id: 'execution-planning',
    name: 'Execution planning',
    description: 'Build a dependency-aware tree of small execution tasks.',
    instructions:
      'Produce a milestone, slice, and task tree with explicit dependencies, selected ability codes, observable success criteria, and self-contained task context. Keep each task suitable for one short worker session.',
    enabled: true
  },
  {
    id: 'task-execution',
    name: 'Task execution',
    description: 'Execute one bounded task and report auditable evidence.',
    instructions:
      'Work only on the assigned task and its success criteria. Keep changes scoped, verify the result with the most relevant checks, and report concrete evidence through the required task result tool.',
    enabled: true
  },
  {
    id: 'slice-evidence-review',
    name: 'Slice evidence review',
    description: 'Review slice progress from structured task evidence.',
    instructions:
      'Judge the slice only from the supplied evidence bundle. Identify concrete repair targets when evidence does not support the slice success criteria.',
    enabled: true
  },
  {
    id: 'milestone-acceptance',
    name: 'Milestone acceptance',
    description: 'Apply a formal milestone acceptance gate.',
    instructions:
      'Trace milestone success criteria to slice verdicts and task evidence. Pass only when the evidence supports the complete milestone; otherwise return actionable repair targets or a clear blocker.',
    enabled: true
  }
]

const DEFAULT_ASSIGNMENTS: BusinessSkillsSettings['assignments'] = {
  conversation: ['conversation-read-only'],
  draft: ['draft-requirements'],
  planner: ['execution-planning'],
  taskWorker: ['task-execution'],
  sliceVerifier: ['slice-evidence-review'],
  milestoneVerifier: ['milestone-acceptance']
}

function cloneDefaults(): BusinessSkillsSettings {
  return {
    revision: 0,
    skills: DEFAULT_SKILLS.map((skill) => ({ ...skill })),
    assignments: Object.fromEntries(
      BUSINESS_SKILL_WORKFLOWS.map((workflow) => [workflow, [...DEFAULT_ASSIGNMENTS[workflow]]])
    ) as BusinessSkillsSettings['assignments']
  }
}

function parseSkill(value: unknown): BusinessSkillDefinition | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === 'string' ? record.id.trim() : ''
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const instructions = typeof record.instructions === 'string' ? record.instructions.trim() : ''
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(id) || !name || !instructions) return null
  return {
    id,
    name,
    description: typeof record.description === 'string' ? record.description.trim() : '',
    instructions,
    enabled: record.enabled !== false
  }
}

function parseAssignments(
  value: unknown,
  validIds: ReadonlySet<string>
): BusinessSkillsSettings['assignments'] {
  const record =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return Object.fromEntries(
    BUSINESS_SKILL_WORKFLOWS.map((workflow) => {
      const raw = Array.isArray(record[workflow]) ? record[workflow] : []
      const ids = [
        ...new Set(
          raw.filter((id): id is string => typeof id === 'string' && validIds.has(id.trim()))
        )
      ]
      return [workflow, ids]
    })
  ) as BusinessSkillsSettings['assignments']
}

export function loadBusinessSkillsSettings(): BusinessSkillsSettings {
  const current = getAppContext().settings.readNamespace('business_skills')
  const raw = current.value
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return cloneDefaults()
  const record = raw as Record<string, unknown>
  if (!Array.isArray(record.skills)) return cloneDefaults()
  const skills = record.skills
    .map(parseSkill)
    .filter((skill): skill is BusinessSkillDefinition => !!skill)
  const uniqueSkills = [...new Map(skills.map((skill) => [skill.id, skill])).values()]
  return {
    revision: current.revision,
    skills: uniqueSkills,
    assignments: parseAssignments(
      record.assignments,
      new Set(uniqueSkills.map((skill) => skill.id))
    )
  }
}

export function saveBusinessSkillsSettings(input: BusinessSkillsSettings): BusinessSkillsSettings {
  const skills = input.skills
    .map(parseSkill)
    .filter((skill): skill is BusinessSkillDefinition => !!skill)
  if (skills.length !== input.skills.length) {
    throw new Error(
      'Every skill requires a unique kebab-case id, a name, and non-empty instructions'
    )
  }
  const uniqueSkills = [...new Map(skills.map((skill) => [skill.id, skill])).values()]
  if (uniqueSkills.length !== skills.length) throw new Error('Business skill ids must be unique')

  const value: Omit<BusinessSkillsSettings, 'revision'> = {
    skills: uniqueSkills,
    assignments: parseAssignments(input.assignments, new Set(uniqueSkills.map((skill) => skill.id)))
  }
  const revision = getAppContext().settings.writeNamespace('business_skills', value, {
    expectedRevision: input.revision
  })
  return { revision, ...value }
}

export function resolveBusinessSkillSnapshot(
  workflow: BusinessSkillWorkflow
): BusinessSkillSnapshot {
  const settings = loadBusinessSkillsSettings()
  const skillsById = new Map(settings.skills.map((skill) => [skill.id, skill]))
  const selected = settings.assignments[workflow]
    .map((id) => skillsById.get(id))
    .filter((skill): skill is BusinessSkillDefinition => Boolean(skill?.enabled))
  return {
    skillIds: selected.map((skill) => skill.id),
    instructions: selected.map((skill) => `### ${skill.name}\n${skill.instructions}`).join('\n\n')
  }
}

export function appendBusinessSkillSnapshot(
  basePrompt: string,
  snapshot: BusinessSkillSnapshot
): string {
  if (!snapshot.instructions.trim()) return basePrompt
  return `${basePrompt}\n\n## Business skills\n\n${snapshot.instructions}`
}
