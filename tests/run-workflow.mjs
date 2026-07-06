import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.TSX_TSCONFIG_PATH = join(root, 'tsconfig.node.json')

const workflowDir = join(root, 'tests', 'workflow')
const files = readdirSync(workflowDir)
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', 'workflow', name))

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], {
  cwd: root,
  stdio: 'inherit',
  env: process.env
})

process.exit(result.status ?? 1)
