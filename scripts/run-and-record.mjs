#!/usr/bin/env node

import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, win32 } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export function resolveInvocation(platform, execPath, requestedCommand, requestedArgs) {
  if (platform === 'win32' && requestedCommand === 'npm') {
    return {
      command: execPath,
      args: [
        win32.join(win32.dirname(execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        ...requestedArgs
      ],
      npmCli: true
    }
  }
  return { command: requestedCommand, args: requestedArgs, npmCli: false }
}

export function main(argv = process.argv) {
  const separator = argv.indexOf('--')
  const outputIndex = argv.indexOf('--out')
  const output = outputIndex >= 0 ? argv[outputIndex + 1] : undefined
  if (!output || separator < 0 || separator === argv.length - 1) {
    throw new Error('usage: run-and-record --out <log> -- <command> [args...]')
  }

  const invocation = resolveInvocation(
    process.platform,
    process.execPath,
    argv[separator + 1],
    argv.slice(separator + 2)
  )
  if (invocation.npmCli && !existsSync(invocation.args[0])) {
    throw new Error(`run_and_record.npm_cli_missing:${invocation.args[0]}`)
  }
  mkdirSync(dirname(output), { recursive: true })
  const log = createWriteStream(output, { flags: 'w' })
  const child = spawn(invocation.command, invocation.args, {
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
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
