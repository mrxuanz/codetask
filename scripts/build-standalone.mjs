#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, env = process.env, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

const electronVite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

run(process.execPath, [join(root, 'scripts', 'ensure-node-native.mjs')])
// Windows: Node cannot spawn .cmd shims without a shell (EINVAL).
if (process.platform === 'win32') {
  run('npm run typecheck', [], process.env, { shell: true })
} else {
  run('npm', ['run', 'typecheck'])
}
run(process.execPath, [electronVite, 'build'], {
  ...process.env,
  CODETASK_BUILD_TARGET: 'standalone'
})
