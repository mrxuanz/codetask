#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveInvocation } from './run-and-record.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) process.exit(result.status ?? 1)
}

const electronVite = join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js')

run(process.execPath, [join(root, 'scripts', 'ensure-node-native.mjs')])
const npmTypecheck = resolveInvocation(process.platform, process.execPath, 'npm', [
  'run',
  'typecheck'
])
run(npmTypecheck.command, npmTypecheck.args)
run(process.execPath, [electronVite, 'build', '--mode', 'standalone'])
