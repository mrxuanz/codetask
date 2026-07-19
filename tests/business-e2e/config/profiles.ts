export type DriverProvider = 'opencode' | 'fake' | 'supervisor'

export type RoleProviders = {
  conversation: string
  planner: string
  taskWorker: string
  sliceVerifier: string
  milestoneVerifier: string
}

export type ProfileName = 'fixed-opencode'

export type Profile = {
  name: ProfileName
  driverProvider: DriverProvider
  roleProviders: RoleProviders
}

export const PROFILES: Record<ProfileName, Profile> = {
  'fixed-opencode': {
    name: 'fixed-opencode',
    driverProvider: 'opencode',
    roleProviders: {
      conversation: 'opencode',
      planner: 'opencode',
      taskWorker: 'opencode',
      sliceVerifier: 'opencode',
      milestoneVerifier: 'opencode'
    }
  }
}

export function resolveProfile(name: string | undefined): Profile {
  const key = (name ?? 'fixed-opencode') as ProfileName
  const profile = PROFILES[key]
  if (!profile) {
    throw new Error(`unknown_profile:${name}`)
  }
  return profile
}
