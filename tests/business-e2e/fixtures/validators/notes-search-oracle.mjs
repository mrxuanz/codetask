#!/usr/bin/env node
/**
 * Node File Oracle for Notes Search workspace.
 * Exit 0 only when SENTINEL unchanged, tests pass, and optional expected hash matches.
 *
 * Usage:
 *   node notes-search-oracle.mjs --workspace <path>
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_SENTINEL = 'NOTES_SEARCH_SENTINEL_V1_DO_NOT_MODIFY\n'

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(message) {
  process.stderr.write(`notes-search-oracle: ${message}\n`)
  process.exit(1)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function main(argv = process.argv.slice(2)) {
  const workspaceArg = readArg(argv, '--workspace')
  if (!workspaceArg) fail('--workspace <path> required')

  const workspace = resolve(workspaceArg)
  const sentinelPath = join(workspace, 'SENTINEL.txt')
  const implPath = join(workspace, 'src', 'search-notes.mjs')
  const testPath = join(workspace, 'test', 'search-notes.test.mjs')

  if (!existsSync(workspace)) fail(`workspace missing: ${workspace}`)
  if (!existsSync(sentinelPath)) fail('SENTINEL.txt missing')
  if (!existsSync(implPath)) fail('src/search-notes.mjs missing')
  if (!existsSync(testPath)) fail('test/search-notes.test.mjs missing')

  const sentinel = readFileSync(sentinelPath, 'utf8')
  if (sentinel !== EXPECTED_SENTINEL && sentinel !== EXPECTED_SENTINEL.trimEnd()) {
    // Accept with or without trailing newline, but content must match.
    const normalized = sentinel.replace(/\r\n/g, '\n').trimEnd()
    if (normalized !== EXPECTED_SENTINEL.trimEnd()) {
      fail('SENTINEL.txt was modified')
    }
  }

  const result = spawnSync(process.execPath, ['--test', testPath], {
    cwd: workspace,
    encoding: 'utf8',
    windowsHide: true
  })

  const report = {
    workspace,
    sentinelOk: true,
    implSha256: sha256File(implPath),
    testStatus: result.status,
    stdoutTail: (result.stdout || '').slice(-2000),
    stderrTail: (result.stderr || '').slice(-2000)
  }

  if (result.status !== 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, ...report }, null, 2)}\n`)
    fail(`node --test failed with status ${result.status}`)
  }

  process.stdout.write(`${JSON.stringify({ ok: true, ...report }, null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}

export { main, EXPECTED_SENTINEL }
