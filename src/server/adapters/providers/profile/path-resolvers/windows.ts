import { join, normalize, resolve } from 'node:path'
import type { ProviderProfileCode } from '../types.ts'
import {
  assertNotWholeHome,
  emptyIdentity,
  requireHome,
  resolveCommonIdentity
} from './shared.ts'
import type {
  HostEnv,
  HostRoots,
  PlatformPathResolver,
  ProviderIdentityPaths
} from './types.ts'

/**
 * Windows path resolver — precise AppData / LocalAppData identity paths
 * (never whole USERPROFILE).
 */
export class WindowsPathResolver implements PlatformPathResolver {
  readonly platform = 'win32' as const

  resolveHostRoots(env: HostEnv): HostRoots {
    const home = requireHome(env, ['USERPROFILE', 'HOME'])
    const appData = env.APPDATA?.trim()
      ? normalize(resolve(env.APPDATA.trim()))
      : join(home, 'AppData', 'Roaming')
    const localAppData = env.LOCALAPPDATA?.trim()
      ? normalize(resolve(env.LOCALAPPDATA.trim()))
      : join(home, 'AppData', 'Local')
    return { home, appData, localAppData }
  }

  resolveIdentityPaths(
    provider: ProviderProfileCode,
    roots: HostRoots,
    env: HostEnv = {}
  ): ProviderIdentityPaths {
    switch (provider) {
      case 'codex': {
        const codexHome = env.CODEX_HOME?.trim()
          ? normalize(resolve(env.CODEX_HOME.trim()))
          : join(roots.home, '.codex')
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [join(codexHome, 'auth.json')],
          credentialDirs: [codexHome],
          configDirs: [codexHome]
        })
      }
      case 'claude-code':
      case 'claude': {
        const configDir = env.CLAUDE_CONFIG_DIR?.trim()
          ? normalize(resolve(env.CLAUDE_CONFIG_DIR.trim()))
          : join(roots.home, '.claude')
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [
            join(configDir, 'settings.json'),
            join(configDir, 'settings.local.json')
          ],
          credentialDirs: [configDir],
          configDirs: [configDir]
        })
      }
      case 'cursorcli':
      case 'cursor': {
        const cursorHome = join(roots.home, '.cursor')
        const configDir = join(roots.appData, 'cursor')
        const appCursor = join(roots.appData, 'Cursor')
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [join(appCursor, 'auth.json'), join(configDir, 'auth.json')],
          credentialDirs: [cursorHome, configDir, appCursor],
          configDirs: [cursorHome, configDir, appCursor]
        })
      }
      case 'opencode': {
        const configDir = join(roots.appData, 'opencode')
        const dataDir = join(roots.localAppData, 'opencode')
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [
            join(configDir, 'auth.json'),
            join(configDir, 'credentials.json'),
            join(dataDir, 'auth.json'),
            join(dataDir, 'credentials.json')
          ],
          credentialDirs: [configDir, dataDir],
          configDirs: [configDir, dataDir]
        })
      }
      case 'fake':
        return emptyIdentity(provider)
      default:
        return emptyIdentity(provider)
    }
  }

  assertPrecisePath(candidate: string, roots: HostRoots): void {
    assertNotWholeHome(candidate, roots)
  }
}

export const windowsPathResolver = new WindowsPathResolver()
