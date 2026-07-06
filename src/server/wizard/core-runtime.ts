import type { WizardPhase } from './types'

export type PhaseRuntimeMap = Partial<Record<WizardPhase, string | null>>

export type CoreRuntimeMap = Record<string, PhaseRuntimeMap | string | null>

export function parseCoreRuntimeJson(json: string): CoreRuntimeMap {
  try {
    const value = JSON.parse(json) as CoreRuntimeMap
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

function normalizePhaseEntry(entry: PhaseRuntimeMap | string | null | undefined): PhaseRuntimeMap {
  if (entry === undefined || entry === null) return {}
  if (typeof entry === 'string') {
    return { collect: entry, draft_review: entry, plan_edit: entry }
  }
  return { ...entry }
}

export function getCorePhaseRuntime(
  map: CoreRuntimeMap,
  coreCode: string,
  wizardPhase: WizardPhase
): string | null {
  const entry = map[coreCode]
  if (entry === undefined || entry === null) return null
  if (typeof entry === 'string') return entry
  const sessionId = entry[wizardPhase]
  return sessionId ?? null
}

export function setCorePhaseRuntime(
  map: CoreRuntimeMap,
  coreCode: string,
  wizardPhase: WizardPhase,
  sessionId: string | null
): CoreRuntimeMap {
  const next: CoreRuntimeMap = { ...map }
  const phases = normalizePhaseEntry(next[coreCode])
  phases[wizardPhase] = sessionId
  next[coreCode] = phases
  return next
}

export function clearCorePhaseRuntime(
  map: CoreRuntimeMap,
  coreCode: string,
  wizardPhase: WizardPhase
): CoreRuntimeMap {
  return setCorePhaseRuntime(map, coreCode, wizardPhase, null)
}
