#!/usr/bin/env node
/**
 * Source-direct Service + Vite Web dev (01 §14.2).
 * Does not require out/ or electron-vite build / Electron.
 * Service product config is CLI argv (Batch C); orchestrator may still use CI/tooling env.
 * Writes `.codetask-run-manifest.json` so Vite proxy does not read CODETASK_SERVICE_URL.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
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

const servicePort = process.env.CODETASK_SERVICE_PORT || '8080'
const webPort = process.env.CODETASK_WEB_PORT || '5173'
const serviceUrl = `http://127.0.0.1:${servicePort}`
const rendererDevUrl = `http://127.0.0.1:${webPort}`

writeFileSync(
  path.join(root, '.codetask-run-manifest.json'),
  `${JSON.stringify({ serviceUrl, webUrl: rendererDevUrl, servicePort: Number(servicePort) }, null, 2)}\n`,
  'utf8'
)

const service = run(process.execPath, [
  '--import',
  path.join(root, 'tests/tsx-tsconfig.mjs'),
  require.resolve('tsx/cli'),
  'watch',
  path.join(root, 'apps/service/src/main.ts'),
  '--port',
  servicePort,
  '--renderer-dev-url',
  rendererDevUrl
])

const viteBin = path.join(root, 'node_modules/vite/bin/vite.js')
const web = run(process.execPath, [
  viteBin,
  '--config',
  path.join(root, 'apps/web/vite.config.ts'),
  '--port',
  webPort
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
