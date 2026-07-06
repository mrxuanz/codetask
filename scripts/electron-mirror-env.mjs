import { spawnSync } from 'child_process'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.ELECTRON_MIRROR ??= 'https://npmmirror.com/mirrors/electron/'
process.env.ELECTRON_BUILDER_BINARIES_MIRROR ??=
  'https://npmmirror.com/mirrors/electron-builder-binaries/'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const localBin = join(root, 'node_modules', '.bin')
const nodeBin = dirname(process.execPath)
const pathEntries = [localBin, nodeBin, process.env.PATH].filter(Boolean)
process.env.PATH = pathEntries.join(delimiter)

const [, , command, ...args] = process.argv
if (!command) {
  process.exit(0)
}

const result = spawnSync(command, args, {
  stdio: 'inherit',
  shell: true,
  env: process.env
})
process.exit(result.status ?? 1)
