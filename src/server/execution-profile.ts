import type { BusinessSkillSnapshot, JobExecutionProfile } from '@codetask/contracts'

import { isSupportedCoreCode } from '../shared/providers/codes.ts'

const EXECUTION_PROFILE_KEYS = new Set([
  'plannerCoreCode',
  'sliceVerifierCoreCode',
  'milestoneVerifierCoreCode',
  'skills'
])
const EXECUTION_PROFILE_SKILL_KEYS = new Set([
  'planner',
  'taskWorker',
  'sliceVerifier',
  'milestoneVerifier'
])

function parseSkillSnapshot(value: unknown): BusinessSkillSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (
    !Array.isArray(record.skillIds) ||
    !record.skillIds.every((id) => typeof id === 'string') ||
    typeof record.instructions !== 'string'
  ) {
    return null
  }
  return {
    skillIds: [...new Set(record.skillIds.map((id) => id.trim()).filter(Boolean))],
    instructions: record.instructions
  }
}

export function parseJobExecutionProfile(value: unknown): JobExecutionProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !EXECUTION_PROFILE_KEYS.has(key))) return null
  const plannerCoreCode = record.plannerCoreCode
  const sliceVerifierCoreCode = record.sliceVerifierCoreCode
  const milestoneVerifierCoreCode = record.milestoneVerifierCoreCode
  if (
    typeof plannerCoreCode !== 'string' ||
    !isSupportedCoreCode(plannerCoreCode) ||
    typeof sliceVerifierCoreCode !== 'string' ||
    !isSupportedCoreCode(sliceVerifierCoreCode) ||
    typeof milestoneVerifierCoreCode !== 'string' ||
    !isSupportedCoreCode(milestoneVerifierCoreCode)
  ) {
    return null
  }

  const skills =
    record.skills && typeof record.skills === 'object' && !Array.isArray(record.skills)
      ? (record.skills as Record<string, unknown>)
      : null
  if (!skills) return null
  if (Object.keys(skills).some((key) => !EXECUTION_PROFILE_SKILL_KEYS.has(key))) return null

  const planner = parseSkillSnapshot(skills.planner)
  const taskWorker = parseSkillSnapshot(skills.taskWorker)
  const sliceVerifier = parseSkillSnapshot(skills.sliceVerifier)
  const milestoneVerifier = parseSkillSnapshot(skills.milestoneVerifier)
  if (!planner || !taskWorker || !sliceVerifier || !milestoneVerifier) return null

  return {
    plannerCoreCode,
    sliceVerifierCoreCode,
    milestoneVerifierCoreCode,
    skills: {
      planner,
      taskWorker,
      sliceVerifier,
      milestoneVerifier
    }
  }
}

export function parseJobExecutionProfileJson(value: string | null): JobExecutionProfile | null {
  if (!value) return null
  try {
    return parseJobExecutionProfile(JSON.parse(value))
  } catch {
    return null
  }
}
