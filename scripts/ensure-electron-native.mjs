import { spawnSync } from 'child_process'
import { createRequire } from 'module'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { resolveInvocation } from './run-and-record.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const electron = require('electron')

function runElectronLoadTest() {
  return spawnSync(
    electron,
    ['-e', "const Database=require('better-sqlite3'); new Database(':memory:');"],
    {
      cwd: root,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: 'pipe'
    }
  )
}

let probe = runElectronLoadTest()
if (probe.status === 0) {
  process.exit(0)
}

console.log('[native] better-sqlite3 is not built for Electron; rebuilding…')
const rebuildInvocation = resolveInvocation(process.platform, process.execPath, 'npm', [
  'run',
  'rebuild:electron'
])
const rebuild = spawnSync(rebuildInvocation.command, rebuildInvocation.args, {
  cwd: root,
  stdio: 'inherit'
})
if ((rebuild.status ?? 1) !== 0) {
  process.exit(rebuild.status ?? 1)
}

probe = runElectronLoadTest()
if (probe.status !== 0) {
  const detail = probe.stderr?.toString().trim() || probe.stdout?.toString().trim()
  console.error('[native] Electron still cannot load better-sqlite3 after rebuild.')
  if (detail) console.error(detail)
  process.exit(1)
}
