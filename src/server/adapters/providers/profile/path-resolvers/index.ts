import { linuxPathResolver } from './linux.ts'
import { macosPathResolver } from './macos.ts'
import { windowsPathResolver } from './windows.ts'
import type { PathResolverPlatform, PlatformPathResolver } from './types.ts'

export type {
  HostEnv,
  HostRoots,
  PathResolverPlatform,
  PlatformPathResolver,
  ProviderIdentityPaths
} from './types.ts'
export { PathResolverError } from './types.ts'
export { assertNotWholeHome, ensureUnderHome } from './shared.ts'
export { MacosPathResolver, macosPathResolver } from './macos.ts'
export { LinuxPathResolver, linuxPathResolver } from './linux.ts'
export { WindowsPathResolver, windowsPathResolver } from './windows.ts'

export function getPathResolver(platform: PathResolverPlatform): PlatformPathResolver {
  switch (platform) {
    case 'darwin':
      return macosPathResolver
    case 'linux':
      return linuxPathResolver
    case 'win32':
      return windowsPathResolver
    default: {
      const _exhaustive: never = platform
      throw new Error(`Unsupported path resolver platform: ${String(_exhaustive)}`)
    }
  }
}

/** Resolve the path resolver for the current Node platform (maps unknown → linux). */
export function getHostPathResolver(
  platform: NodeJS.Platform = process.platform
): PlatformPathResolver {
  if (platform === 'darwin') return macosPathResolver
  if (platform === 'win32') return windowsPathResolver
  return linuxPathResolver
}
