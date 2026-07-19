#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function fail(msg) {
  process.stderr.write(`chain-oracle: ${msg}\n`)
  process.exit(1)
}

function main(argv = process.argv.slice(2)) {
  const idx = argv.indexOf('--workspace')
  if (idx < 0) fail('--workspace required')
  const workspace = resolve(argv[idx + 1])
  const a = join(workspace, 'artifacts/01-input.json')
  const b = join(workspace, 'artifacts/02-result.json')
  if (!existsSync(a) || !existsSync(b)) fail('missing artifacts')
  const input = readFileSync(a)
  const result = JSON.parse(readFileSync(b, 'utf8'))
  const hash = createHash('sha256').update(input).digest('hex')
  if (result.hash !== hash) fail('hash mismatch')
  process.stdout.write(JSON.stringify({ ok: true, hash }, null, 2) + '\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
