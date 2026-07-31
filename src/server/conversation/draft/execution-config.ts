import type { AgentCapabilityProfile } from '../../agent-runtime/capabilities'
import { providerSupportsCapability } from '../../agent-runtime/capabilities'
import { AppError } from '../../error'
import { ensureCoreAvailable, normalizeCoreCode } from '../cores'
import type { DraftExecutionConfig } from './types'

const EXECUTION_CORE_FIELDS = [
  ['plannerCoreCode', 'planner-read'],
  ['sliceVerifierCoreCode', 'verifier-sandbox'],
  ['milestoneVerifierCoreCode', 'verifier-sandbox']
] as const satisfies ReadonlyArray<[keyof DraftExecutionConfig, AgentCapabilityProfile]>

export function parseDraftExecutionConfig(value: unknown): DraftExecutionConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw AppError.badRequest('Execution config is required', 'draft.execution_config_required')
  }
  const record = value as Record<string, unknown>
  try {
    return {
      plannerCoreCode: normalizeCoreCode(String(record.plannerCoreCode ?? '')),
      sliceVerifierCoreCode: normalizeCoreCode(String(record.sliceVerifierCoreCode ?? '')),
      milestoneVerifierCoreCode: normalizeCoreCode(String(record.milestoneVerifierCoreCode ?? ''))
    }
  } catch {
    throw AppError.badRequest(
      'Planner and verifier selections must use supported CLIs',
      'draft.execution_core_invalid'
    )
  }
}

export async function ensureDraftExecutionConfigAvailable(
  config: DraftExecutionConfig
): Promise<void> {
  for (const [field, capability] of EXECUTION_CORE_FIELDS) {
    const core = await ensureCoreAvailable(config[field]).catch((error: Error) => {
      throw AppError.badRequest(error.message, 'provider.unavailable')
    })
    if (!providerSupportsCapability(core.code, capability)) {
      throw AppError.badRequest(
        `${field} selected CLI (${core.label}) cannot enforce ${capability}`,
        'provider.capability_unsupported'
      )
    }
  }
}
