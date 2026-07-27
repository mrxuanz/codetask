import { spawnSync } from 'child_process'
import { dirname, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInvocation } from './run-and-record.mjs'

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

const invocation = resolveInvocation(process.platform, process.execPath, command, args)
const result = spawnSync(invocation.command, invocation.args, {
  stdio: 'inherit',
  env: process.env
})
process.exit(result.status ?? 1)
