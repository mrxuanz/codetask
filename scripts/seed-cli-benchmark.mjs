import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
process.env.TSX_TSCONFIG_PATH = join(root, 'tsconfig.node.json')

const ensureNative = spawnSync(
  process.execPath,
  [join(root, 'scripts', 'ensure-node-native.mjs')],
  {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  }
)
if ((ensureNative.status ?? 1) !== 0) {
  process.exit(ensureNative.status ?? 1)
}

const result = spawnSync(
  process.execPath,
  ['--import', 'tsx', join(root, 'scripts', 'seed-cli-benchmark.ts'), ...process.argv.slice(2)],
  { cwd: root, stdio: 'inherit', env: process.env }
)

process.exit(result.status ?? 1)
