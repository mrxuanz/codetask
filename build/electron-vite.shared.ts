import { resolve } from 'node:path'

export const sandboxInputs = {
  'sandbox/role-worker': resolve('src/sandbox/role-worker.ts'),
  'sandbox/role-worker-cursor-job': resolve('src/sandbox/role-worker-cursor-job.ts'),
  'sandbox/supervisor-entry': resolve('src/sandbox/supervisor-entry.ts'),
  'sandbox/provider-runtime-diagnostics': resolve('src/sandbox/provider-runtime-diagnostics.ts')
}

/** Source workspaces must be bundled because their package exports point at raw TypeScript. */
export const bundledWorkspacePackages = [
  '@codetask/server-core',
  '@codetask/contracts',
  '@codetask/database',
  '@codetask/agent-runtime',
  '@codetask/provider-spec',
  '@codetask/provider-runtime-node',
  '@codetask/service-bootstrap'
]

export const mainAliases = {
  '@server': resolve('src/server')
}

export const rendererRoot = resolve('apps/web')
export const rendererInput = resolve('apps/web/index.html')
export const rendererAliases = {
  '@renderer': resolve('apps/web/src')
}
