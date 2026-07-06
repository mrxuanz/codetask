import { spawnSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function runNodeLoadTest() {
  return spawnSync(
    process.execPath,
    ['-e', "const Database=require('better-sqlite3'); new Database(':memory:');"],
    {
      cwd: root,
      stdio: 'pipe'
    }
  )
}

let probe = runNodeLoadTest()
if (probe.status === 0) {
  process.exit(0)
}

console.log('[native] better-sqlite3 is not built for system Node; rebuilding…')
const rebuild = spawnSync('npm', ['run', 'rebuild:node'], {
  cwd: root,
  stdio: 'inherit',
  shell: true
})
if ((rebuild.status ?? 1) !== 0) {
  process.exit(rebuild.status ?? 1)
}

probe = runNodeLoadTest()
if (probe.status !== 0) {
  const detail = probe.stderr?.toString().trim() || probe.stdout?.toString().trim()
  console.error('[native] system Node still cannot load better-sqlite3 after rebuild.')
  if (detail) console.error(detail)
  process.exit(1)
}
