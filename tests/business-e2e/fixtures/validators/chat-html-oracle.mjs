#!/usr/bin/env node
/**
 * Node File Oracle for conversation create-html cases.
 *
 * Usage:
 *   node chat-html-oracle.mjs --workspace <path> --file opencode.html [--marker BUSINESS_E2E_CHAT_HTML]
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_MARKER = 'BUSINESS_E2E_CHAT_HTML'

function readArg(argv, name) {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

function fail(message) {
  process.stderr.write(`chat-html-oracle: ${message}\n`)
  process.exit(1)
}

function main(argv = process.argv.slice(2)) {
  const workspaceArg = readArg(argv, '--workspace')
  const fileName = readArg(argv, '--file')
  const marker = readArg(argv, '--marker') || DEFAULT_MARKER

  if (!workspaceArg) fail('--workspace <path> required')
  if (!fileName) fail('--file <name.html> required')

  const workspace = resolve(workspaceArg)
  const target = join(workspace, fileName)

  if (!existsSync(workspace)) fail(`workspace missing: ${workspace}`)
  if (!existsSync(target)) fail(`expected file missing: ${fileName}`)

  const st = statSync(target)
  if (!st.isFile()) fail(`${fileName} is not a file`)
  if (st.size < 16) fail(`${fileName} too small`)

  const text = readFileSync(target, 'utf8')
  if (!/<html[\s>]/i.test(text) && !/<!doctype\s+html/i.test(text)) {
    fail(`${fileName} does not look like HTML`)
  }
  if (!text.includes(marker)) {
    fail(`${fileName} missing marker ${marker}`)
  }

  const report = {
    ok: true,
    workspace,
    file: fileName,
    bytes: st.size,
    marker
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
}

export { main, DEFAULT_MARKER }
