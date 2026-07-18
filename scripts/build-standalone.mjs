#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: root,
    env,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const electronVite = join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

run(process.execPath, [join(root, 'scripts', 'ensure-node-native.mjs')])
run(npm, ['run', 'typecheck'])
run(electronVite, ['build'], { ...process.env, CODETASK_BUILD_TARGET: 'standalone' })
