import { execFileSync } from 'child_process'
import { dirname, join, normalize } from 'path'
import { existsSync, realpathSync } from 'fs'
import { resolveMainSandboxScript } from './packaged-paths'

function safeRealpath(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    try {
      return realpathSync(path)
    } catch {
      return normalize(path)
    }
  }
}

function addRoot(roots: Map<string, string>, path: string | null | undefined): void {
  if (!path?.trim() || !existsSync(path)) return
  const normalized = normalize(path)
  roots.set(normalized.toLowerCase(), normalized)
  const real = safeRealpath(normalized)
  roots.set(real.toLowerCase(), real)
}

export function resolveRuntimeReadRoots(): string[] {
  const roots = new Map<string, string>()

  addRoot(roots, process.execPath)
  addRoot(roots, dirname(process.execPath))

  if (process.env.NODE_PATH) {
    for (const segment of process.env.NODE_PATH.split(process.platform === 'win32' ? ';' : ':')) {
      addRoot(roots, segment.trim())
    }
  }

  const worker = resolveMainSandboxScript('role-worker.js')
  if (worker) {
    addRoot(roots, dirname(worker))
    addRoot(roots, dirname(dirname(worker)))

    addRoot(roots, join(dirname(worker), '..', '..', '..', 'node_modules'))
  }

  if (process.platform !== 'win32') {
    for (const certPath of ['/etc/ssl/certs', '/etc/pki/tls/certs', '/etc/ca-certificates']) {
      addRoot(roots, certPath)
    }
    addRoot(roots, process.env.npm_config_cache)
    addRoot(roots, join(process.env.HOME ?? '', '.npm'))
  } else {
    addRoot(roots, process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'npm-cache') : null)
  }

  try {
    const npmRoot = execFileSync(process.execPath, ['-p', 'require.resolve.paths("module")'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }).trim()
    if (npmRoot) addRoot(roots, npmRoot)
  } catch {
    // ignore
  }

  return [...roots.values()]
}
