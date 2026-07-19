export type DriverProvider = 'opencode' | 'fake' | 'supervisor'

export type SutCoreCode = 'opencode' | 'cursorcli' | 'claude-code' | 'codex'

export type RoleProviders = {
  conversation: string
  planner: string
  taskWorker: string
  sliceVerifier: string
  milestoneVerifier: string
}

export type ProfileName = 'fixed-opencode' | 'fixed-cursor' | 'fixed-claude' | 'fixed-codex'

export type Profile = {
  name: ProfileName
  driverProvider: DriverProvider
  roleProviders: RoleProviders
}

function fixedRoles(core: SutCoreCode): RoleProviders {
  return {
    conversation: core,
    planner: core,
    taskWorker: core,
    sliceVerifier: core,
    milestoneVerifier: core
  }
}

export const PROFILES: Record<ProfileName, Profile> = {
  'fixed-opencode': {
    name: 'fixed-opencode',
    driverProvider: 'opencode',
    roleProviders: fixedRoles('opencode')
  },
  'fixed-cursor': {
    name: 'fixed-cursor',
    driverProvider: 'opencode',
    roleProviders: fixedRoles('cursorcli')
  },
  'fixed-claude': {
    name: 'fixed-claude',
    driverProvider: 'opencode',
    roleProviders: fixedRoles('claude-code')
  },
  'fixed-codex': {
    name: 'fixed-codex',
    driverProvider: 'opencode',
    roleProviders: fixedRoles('codex')
  }
}

export function fixedProfileForCore(core: SutCoreCode): Profile {
  if (core === 'cursorcli') return PROFILES['fixed-cursor']
  if (core === 'claude-code') return PROFILES['fixed-claude']
  if (core === 'codex') return PROFILES['fixed-codex']
  return PROFILES['fixed-opencode']
}

export function resolveProfile(name: string | undefined): Profile {
  const key = (name ?? 'fixed-opencode') as ProfileName
  const profile = PROFILES[key]
  if (!profile) {
    throw new Error(`unknown_profile:${name}`)
  }
  return profile
}
