#!/usr/bin/env node

/**
 * CI gate: forbidden legacy write/recovery symbols must not appear outside
 * allowed paths (migration scripts, adapters, docs).
 *
 * Scoped enforcement:
 * - renderer production paths
 * - control-plane application layer
 * - V3 HTTP layer
 *
 * Usage:
 *   node scripts/control-plane/legacy-write-guard.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exit } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')
const symbolsFile = join(__dirname, 'legacy-write-symbols.rg.txt')

const SEARCH_ROOTS = ['src/renderer', 'src/server/application', 'src/server/http/v3']

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

function listFiles(dir) {
  const entries = readdirSync(join(root, dir), { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.git')) continue

    const relPath = join(dir, entry.name)
    const absPath = join(root, relPath)
    if (entry.isDirectory()) {
      files.push(...listFiles(relPath))
      continue
    }
    if (!entry.isFile()) continue

    const stats = statSync(absPath)
    if (stats.size > 1_000_000) continue
    files.push(relPath)
  }

  return files
}

function findMatches(pattern, searchRoot) {
  const regex = new RegExp(pattern)
  const matches = []

  for (const file of listFiles(searchRoot)) {
    const text = readFileSync(join(root, file), 'utf8')
    const lines = text.split(/\r?\n/)

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]
      const trimmed = line.trim()
      if (
        trimmed.startsWith('//') ||
        trimmed.startsWith('/*') ||
        trimmed.startsWith('*') ||
        trimmed.startsWith('*/')
      ) {
        continue
      }
      if (regex.test(line)) {
        matches.push({
          file: relative(root, join(root, file)).split(sep).join('/'),
          line: index + 1,
          text: line
        })
      }
    }
  }

  return matches
}

const symbols = loadSymbols()
let hasErrors = false

for (const symbol of symbols) {
  for (const searchRoot of SEARCH_ROOTS) {
    const matches = findMatches(symbol, searchRoot).filter((entry) => !isAllowedPath(entry.file))
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

console.log('✅ legacy write guard passed (renderer/app/v3 production paths clean)')
