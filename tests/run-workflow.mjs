import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.TSX_TSCONFIG_PATH = join(root, 'tsconfig.node.json')

const workflowDir = join(root, 'tests', 'workflow')
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => join('tests', 'workflow', name))

// Run each file in its own process so open handles (reapers, timers) from one
// suite cannot block the next file's exit under the shared Node test runner.
let failed = false
for (const file of files) {
  const result = spawnSync(
    process.execPath,
    ['--import', 'tsx', '--test', '--test-concurrency=1', '--test-force-exit', file],
    {
      cwd: root,
      stdio: 'inherit',
      env: process.env
    }
  )
  if ((result.status ?? 1) !== 0) {
    failed = true
  }
}

process.exit(failed ? 1 : 0)
