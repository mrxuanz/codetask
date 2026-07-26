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
 * Linux path resolver — XDG-aware precise identity paths (never whole $HOME).
 */
export class LinuxPathResolver implements PlatformPathResolver {
  readonly platform = 'linux' as const

  resolveHostRoots(env: HostEnv): HostRoots {
    const home = requireHome(env, ['HOME'])
    const configHome = env.XDG_CONFIG_HOME?.trim()
      ? normalize(resolve(env.XDG_CONFIG_HOME.trim()))
      : join(home, '.config')
    const dataHome = env.XDG_DATA_HOME?.trim()
      ? normalize(resolve(env.XDG_DATA_HOME.trim()))
      : join(home, '.local', 'share')
    return {
      home,
      appData: configHome,
      localAppData: dataHome
    }
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
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [join(configDir, 'auth.json'), join(cursorHome, 'auth.json')],
          credentialDirs: [cursorHome, configDir],
          configDirs: [cursorHome, configDir]
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

export const linuxPathResolver = new LinuxPathResolver()
