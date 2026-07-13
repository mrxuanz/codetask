#!/usr/bin/env node

/**
 * CI gate: forbidden legacy write/recovery symbols must not appear outside
 * allowed paths (migration scripts, adapters, docs).
 *
 * Scoped enforcement (pragmatic first cut):
 * - enrichJobWithRecoveryState: forbidden under src/renderer (production path)
 * - remaining symbols listed in legacy-write-symbols.rg.txt are scanned under
 *   src/renderer as well so renderer production cannot reintroduce them.
 *
 * Usage:
 *   node scripts/control-plane/legacy-write-guard.mjs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exit } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')
const symbolsFile = join(__dirname, 'legacy-write-symbols.rg.txt')

const SEARCH_ROOTS = ['src/renderer']

const ALLOWED_PATH_PREFIXES = [
  'scripts/control-plane/',
  'docs/',
  'tests/control-plane/migration/',
  'src/server/application/controls-command-adapter.ts',
  'src/server/application/planner-adapter.ts',
  'src/server/http/legacy-cutover-guard.ts'
]

function loadSymbols() {
  return readFileSync(symbolsFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function isAllowedPath(filePath) {
  const normalized = filePath.split(sep).join('/')
  return ALLOWED_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix)
  )
}

function rg(pattern, searchRoot) {
  try {
    const output = execFileSync(
      'rg',
      ['-n', '--glob', '!**/node_modules/**', pattern, searchRoot],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe']
      }
    )
    return output.trim()
  } catch (error) {
    if (error && typeof error === 'object' && 'status' in error && error.status === 1) {
      return ''
    }
    throw error
  }
}

function parseMatches(output) {
  if (!output) return []
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const match = /^([^:]+):(\d+):(.*)$/.exec(line)
      if (!match) return null
      return {
        file: relative(root, join(root, match[1])).split(sep).join('/'),
        line: Number(match[2]),
        text: match[3]
      }
    })
    .filter(Boolean)
}

const symbols = loadSymbols()
let hasErrors = false

for (const symbol of symbols) {
  for (const searchRoot of SEARCH_ROOTS) {
    const matches = parseMatches(rg(symbol, searchRoot)).filter(
      (entry) => entry && !isAllowedPath(entry.file)
    )
    if (matches.length === 0) continue
    hasErrors = true
    console.error(`\nForbidden legacy symbol "${symbol}" found outside allowed paths:`)
    for (const entry of matches) {
      console.error(`  ${entry.file}:${entry.line}: ${entry.text.trim()}`)
    }
  }
}

if (hasErrors) {
  console.error('\n❌ legacy write symbols found outside allowed paths')
  exit(1)
}

console.log('✅ legacy write guard passed (renderer production paths clean)')
