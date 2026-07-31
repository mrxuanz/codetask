export const BUSINESS_SKILL_WORKFLOWS = [
  'conversation',
  'draft',
  'planner',
  'taskWorker',
  'sliceVerifier',
  'milestoneVerifier'
] as const

export type BusinessSkillWorkflow = (typeof BUSINESS_SKILL_WORKFLOWS)[number]

export interface BusinessSkillDefinition {
  id: string
  name: string
  description: string
  instructions: string
  enabled: boolean
}

export interface BusinessSkillsSettings {
  revision: number
  skills: BusinessSkillDefinition[]
  assignments: Record<BusinessSkillWorkflow, string[]>
}
