import { homedir } from 'os'
import { join, resolve } from 'path'
import type { AppMode } from '../main/cli'
import { resolveStorageLocation, type DataDirResolution } from '../main/storage-locator'

export interface NodeDataDirEnvironment {
  platform?: NodeJS.Platform
  homeDir?: string
  env?: NodeJS.ProcessEnv
}

function environment(input: NodeDataDirEnvironment): {
  platform: NodeJS.Platform
  homeDir: string
  env: NodeJS.ProcessEnv
} {
  return {
    platform: input.platform ?? process.platform,
    homeDir: input.homeDir ?? homedir(),
    env: input.env ?? process.env
  }
}

/** Shared installation metadata stays compatible with the Electron entry point. */
export function resolveNodeBootstrapRoot(input: NodeDataDirEnvironment = {}): string {
  const runtime = environment(input)
  const configured = runtime.env.CODETASK_BOOTSTRAP_ROOT?.trim()
  if (configured) return resolve(configured)

  if (runtime.platform === 'win32') {
    return join(
      runtime.env.APPDATA?.trim() || join(runtime.homeDir, 'AppData', 'Roaming'),
      'CodeTask'
    )
  }
  return join(runtime.env.XDG_CONFIG_HOME?.trim() || join(runtime.homeDir, '.config'), 'codetask')
}

/** Node-owned default data root; an existing shared locator still takes precedence. */
export function resolveNodeDefaultDataDir(input: NodeDataDirEnvironment = {}): string {
  const runtime = environment(input)
  const configured = runtime.env.CODETASK_DATA_HOME?.trim()
  if (configured) return resolve(configured)

  if (runtime.platform === 'win32') {
    const local = runtime.env.LOCALAPPDATA?.trim() || join(runtime.homeDir, 'AppData', 'Local')
    return join(local, 'CodeTask', 'data')
  }
  if (runtime.platform === 'darwin') {
    return join(runtime.homeDir, 'Library', 'Application Support', 'codetask', 'data')
  }
  return join(
    runtime.env.XDG_DATA_HOME?.trim() || join(runtime.homeDir, '.local', 'share'),
    'codetask'
  )
}

export function resolveNodeDataDirSelection(
  input: {
    explicitDataDir?: string
    mode: AppMode
    bootstrapRoot?: string
    defaultDataDir?: string
  },
  runtime: NodeDataDirEnvironment = {}
): DataDirResolution {
  const env = runtime.env ?? process.env
  return resolveStorageLocation({
    explicitDataDir: input.explicitDataDir,
    envDataDir: env.CODETASK_DATA_DIR,
    mode: input.mode,
    bootstrapRoot: input.bootstrapRoot ?? resolveNodeBootstrapRoot(runtime),
    defaultDataDir: input.defaultDataDir ?? resolveNodeDefaultDataDir(runtime)
  })
}
