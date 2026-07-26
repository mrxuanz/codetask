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
 * macOS path resolver — precise identity paths only (never whole $HOME).
 */
export class MacosPathResolver implements PlatformPathResolver {
  readonly platform = 'darwin' as const

  resolveHostRoots(env: HostEnv): HostRoots {
    const home = requireHome(env, ['HOME'])
    return {
      home,
      appData: normalize(resolve(join(home, 'Library', 'Application Support'))),
      localAppData: normalize(resolve(join(home, 'Library', 'Caches')))
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
        const configDir = join(roots.home, '.config', 'cursor')
        const appCursor = join(roots.appData, 'Cursor')
        return resolveCommonIdentity(provider, roots, {
          credentialFiles: [
            join(appCursor, 'auth.json'),
            join(configDir, 'auth.json'),
            join(cursorHome, 'auth.json')
          ],
          credentialDirs: [cursorHome, configDir, appCursor],
          configDirs: [cursorHome, configDir, appCursor]
        })
      }
      case 'opencode': {
        const configDir = join(roots.home, '.config', 'opencode')
        const dataDir = join(roots.home, '.local', 'share', 'opencode')
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

export const macosPathResolver = new MacosPathResolver()
