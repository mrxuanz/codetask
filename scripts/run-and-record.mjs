#!/usr/bin/env node

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { spawn } from 'node:child_process'

const separator = process.argv.indexOf('--')
const outputIndex = process.argv.indexOf('--out')
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined
if (!output || separator < 0 || separator === process.argv.length - 1) {
  throw new Error('usage: run-and-record --out <log> -- <command> [args...]')
}

mkdirSync(dirname(output), { recursive: true })
const log = createWriteStream(output, { flags: 'w' })
const requestedCommand = process.argv[separator + 1]
const command =
  process.platform === 'win32' && requestedCommand === 'npm' ? 'npm.cmd' : requestedCommand
const args = process.argv.slice(separator + 2)
const child = spawn(command, args, {
  env: process.env,
  stdio: ['inherit', 'pipe', 'pipe'],
  windowsHide: true
})

child.stdout.pipe(process.stdout)
child.stdout.pipe(log, { end: false })
child.stderr.pipe(process.stderr)
child.stderr.pipe(log, { end: false })

let spawnError
child.once('error', (error) => {
  spawnError = error
  log.write(`\n[run-and-record] spawn error: ${error.message}\n`)
})

child.once('close', (code, signal) => {
  const exitCode = spawnError ? 1 : (code ?? 1)
  log.end(`\n[run-and-record] exitCode=${exitCode} signal=${signal ?? 'none'}\n`, () => {
    process.exitCode = exitCode
  })
})
