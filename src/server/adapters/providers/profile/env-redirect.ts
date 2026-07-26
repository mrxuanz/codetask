import type { InstanceDirs } from './instance-dirs.ts'

export type EnvRedirectPlatform = 'darwin' | 'linux' | 'win32' | NodeJS.Platform

/**
 * Redirect SDK default dirs into the per-instance tree.
 * Env redirection is NOT the security boundary — native policy must still enforce
 * instance dirs + explicit host allowlist only (重构.md §10.3).
 */
export function buildInstanceEnvRedirect(
  dirs: InstanceDirs,
  platform: EnvRedirectPlatform = process.platform,
  baseEnv: Readonly<Record<string, string>> = {}
): Record<string, string> {
  const env: Record<string, string> = { ...baseEnv }

  if (platform === 'win32') {
    env.USERPROFILE = dirs.home
    env.HOME = dirs.home
    env.APPDATA = joinWin(dirs.home, 'AppData', 'Roaming')
    env.LOCALAPPDATA = joinWin(dirs.home, 'AppData', 'Local')
    env.TEMP = dirs.tmp
    env.TMP = dirs.tmp
    return env
  }

  env.HOME = dirs.home
  env.XDG_CONFIG_HOME = dirs.config
  env.XDG_DATA_HOME = dirs.data
  env.XDG_CACHE_HOME = dirs.cache
  env.XDG_STATE_HOME = dirs.state
  env.TMPDIR = dirs.tmp
  env.TMP = dirs.tmp
  env.TEMP = dirs.tmp
  return env
}

function joinWin(...parts: string[]): string {
  return parts.join('\\')
}

/**
 * Merge profile-declared environment with instance redirects.
 * Profile keys win for provider-owned knobs; redirect keys always applied last
 * so HOME/XDG cannot be steered back to the host profile.
 */
export function mergeProfileEnvironment(
  profileEnvironment: Readonly<Record<string, string>>,
  dirs: InstanceDirs,
  platform: EnvRedirectPlatform = process.platform
): Record<string, string> {
  const redirected = buildInstanceEnvRedirect(dirs, platform, profileEnvironment)
  // Re-apply redirects so profile cannot override isolation homes.
  return buildInstanceEnvRedirect(dirs, platform, redirected)
}
