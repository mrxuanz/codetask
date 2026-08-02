#!/usr/bin/env node
/**
 * Source-direct Service + Vite Web dev (01 §14.2).
 * Does not require out/ or electron-vite build / Electron.
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function run(command, args, env = {}) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  return child
}

const service = run(
  process.execPath,
  [
    '--import',
    path.join(root, 'tests/tsx-tsconfig.mjs'),
    require.resolve('tsx/cli'),
    'watch',
    path.join(root, 'apps/service/src/main.ts')
  ],
  {
    CODETASK_DEV_SERVICE: '1',
    CODETASK_SERVICE_PORT: process.env.CODETASK_SERVICE_PORT || '8080'
  }
)

const viteBin = path.join(root, 'node_modules/vite/bin/vite.js')
const web = run(process.execPath, [
  viteBin,
  '--config',
  path.join(root, 'apps/web/vite.config.ts'),
  '--port',
  process.env.CODETASK_WEB_PORT || '5173'
])

function shutdown(signal) {
  service.kill(signal)
  web.kill(signal)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

service.on('exit', (code) => {
  web.kill('SIGTERM')
  process.exitCode = code ?? 1
})
web.on('exit', (code) => {
  service.kill('SIGTERM')
  if (process.exitCode === undefined) process.exitCode = code ?? 1
})
