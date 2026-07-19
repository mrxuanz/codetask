#!/usr/bin/env node
import { existsSync, accessSync, constants } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(msg) {
  process.stderr.write(`readonly-oracle: ${msg}\n`)
  process.exit(1)
}

function main(argv = process.argv.slice(2)) {
  const idx = argv.indexOf('--workspace')
  if (idx < 0) fail('--workspace required')
  const workspace = resolve(argv[idx + 1])
  if (!existsSync(workspace)) fail('missing workspace')
  try {
    accessSync(workspace, constants.R_OK)
  } catch {
    fail('workspace not readable')
  }
  process.stdout.write(JSON.stringify({ ok: true, workspace }, null, 2) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
