import {
  listChatCores,
  normalizeCoreCode,
  type AgentCoreAvailability,
  type SupportedCoreCode
} from '../conversation/cores'
import { createTurnError } from '../../shared/turn-errors.ts'
import { patchSettingsFile, readSettingsFile } from './store'

export interface ControlPlanePolicies {
  plannerCoreCode: SupportedCoreCode
  sliceVerifierCoreCode: SupportedCoreCode
  milestoneVerifierCoreCode: SupportedCoreCode
  updatedAt: number
}

export interface ControlPlaneSettingsPayload {
  policies: ControlPlanePolicies
  cores: AgentCoreAvailability[]
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const POLICY_FIELDS = [
  'plannerCoreCode',
  'sliceVerifierCoreCode',
  'milestoneVerifierCoreCode'
] as const

async function defaultCoreCode(): Promise<SupportedCoreCode> {
  const cores = await listChatCores()
  const firstAvailable = cores.find((core) => core.available)?.code
  if (firstAvailable) return firstAvailable
  return 'cursorcli'
}

function parsePolicyCore(value: unknown, fallback: SupportedCoreCode): SupportedCoreCode {
  if (typeof value !== 'string' || !value.trim()) return fallback
  try {
    return normalizeCoreCode(value)
  } catch {
    return fallback
  }
}

export async function defaultControlPlanePolicies(): Promise<ControlPlanePolicies> {
  const core = await defaultCoreCode()
  return {
    plannerCoreCode: core,
    sliceVerifierCoreCode: core,
    milestoneVerifierCoreCode: core,
    updatedAt: Math.floor(Date.now() / 1000)
  }
}

export async function loadControlPlanePolicies(): Promise<ControlPlanePolicies> {
  const defaults = await defaultControlPlanePolicies()
  const raw = readSettingsFile().controlPlane
  if (!raw || typeof raw !== 'object') return defaults

  const object = raw as Record<string, unknown>
  return {
    plannerCoreCode: parsePolicyCore(object.plannerCoreCode, defaults.plannerCoreCode),
    sliceVerifierCoreCode: parsePolicyCore(
      object.sliceVerifierCoreCode,
      defaults.sliceVerifierCoreCode
    ),
    milestoneVerifierCoreCode: parsePolicyCore(
      object.milestoneVerifierCoreCode,
      defaults.milestoneVerifierCoreCode
    ),
    updatedAt:
      typeof object.updatedAt === 'number' && Number.isFinite(object.updatedAt)
        ? object.updatedAt
        : defaults.updatedAt
  }
}

export async function loadControlPlaneSettings(): Promise<ControlPlaneSettingsPayload> {
  const [policies, cores] = await Promise.all([loadControlPlanePolicies(), listChatCores()])
  return { policies, cores }
}

function validatePolicyInput(
  field: string,
  value: string,
  cores: AgentCoreAvailability[]
): SupportedCoreCode {
  let code: SupportedCoreCode
  try {
    code = normalizeCoreCode(value)
  } catch {
    throw createTurnError('settings.control_plane.unsupported_core', {
      detail: `${field} is not a supported CLI`
    })
  }
  const core = cores.find((item) => item.code === code)
  if (!core) {
    throw createTurnError('settings.control_plane.unknown_core', {
      detail: `${field} is unknown`
    })
  }
  if (!core.available) {
    throw createTurnError('settings.control_plane.unavailable_core', {
      detail: `${field} selected CLI (${core.label}) is currently unavailable`
    })
  }
  return code
}

export async function saveControlPlanePolicies(input: {
  plannerCoreCode: string
  sliceVerifierCoreCode: string
  milestoneVerifierCoreCode: string
}): Promise<ControlPlanePolicies> {
  const cores = await listChatCores()
  const policies: ControlPlanePolicies = {
    plannerCoreCode: validatePolicyInput('plannerCoreCode', input.plannerCoreCode, cores),
    sliceVerifierCoreCode: validatePolicyInput(
      'sliceVerifierCoreCode',
      input.sliceVerifierCoreCode,
      cores
    ),
    milestoneVerifierCoreCode: validatePolicyInput(
      'milestoneVerifierCoreCode',
      input.milestoneVerifierCoreCode,
      cores
    ),
    updatedAt: Math.floor(Date.now() / 1000)
  }

  patchSettingsFile((file) => {
    file.controlPlane = policies
  })

  return policies
}

export async function resolvePlannerCoreCode(fallback?: string): Promise<SupportedCoreCode> {
  const policies = await loadControlPlanePolicies()
  if (policies.plannerCoreCode) return policies.plannerCoreCode
  if (fallback) {
    try {
      return normalizeCoreCode(fallback)
    } catch {
      // ignore
    }
  }
  return defaultCoreCode()
}

export async function resolveSliceVerifierCoreCode(): Promise<SupportedCoreCode> {
  return (await loadControlPlanePolicies()).sliceVerifierCoreCode
}

export async function resolveMilestoneVerifierCoreCode(): Promise<SupportedCoreCode> {
  return (await loadControlPlanePolicies()).milestoneVerifierCoreCode
}

export const CONTROL_PLANE_POLICY_LABELS: Record<(typeof POLICY_FIELDS)[number], string> = {
  plannerCoreCode: 'Planner',
  sliceVerifierCoreCode: 'Slice Verifier',
  milestoneVerifierCoreCode: 'Milestone Verifier'
}
