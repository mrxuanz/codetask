#!/usr/bin/env node

/**
 * CI gate: forbidden legacy write/recovery symbols must not appear outside
 * allowed paths (migration scripts, adapters, docs).
 *
 * Scoped enforcement:
 * - control-plane application layer
 * - HTTP layer (including legacy cutover guard)
 * - server routes
 * - V3 composition root recursive import graph
 * - production bootstrap / shutdown entrypoints
 *
 * Usage:
 *   node scripts/control-plane/legacy-write-guard.mjs
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exit } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '../..')
const symbolsFile = join(__dirname, 'legacy-write-symbols.rg.txt')

const SEARCH_ROOTS = [
  'src/server/application',
  'src/server/http',
  'src/server/routes'
]

/** V3 composition root — static import closure only (matches composition tests). */
const V3_COMPOSITION_ENTRYPOINTS = [
  'src/server/application/application-runtime.ts',
  'src/server/application/control-plane-runtime.ts',
  'src/server/application/control-plane-services.ts'
]

/** Production bootstrap/shutdown entrypoints scanned for forbidden symbols. */
const BOOTSTRAP_ENTRYPOINTS = ['src/server/bootstrap.ts']

const ALLOWED_PATH_PREFIXES = [
  'scripts/control-plane/',
  'docs/',
  'tests/control-plane/migration/',
  'src/server/application/controls-command-adapter.ts',
  'src/server/application/planner-adapter.ts',
  'src/server/http/legacy-cutover-guard.ts',
  'src/shared/job-recovery-state.ts'
]

const PATH_ALIASES = new Map([
  ['@shared/', 'src/shared/']
])

function loadSymbols() {
  return readFileSync(symbolsFile, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
}

function normalizePath(filePath) {
  return filePath.split(sep).join('/')
}

function isLegacyIsolatedPath(filePath) {
  return normalizePath(filePath).includes('legacy-control-plane/')
}

function isAllowedPath(filePath) {
  const normalized = normalizePath(filePath)
  return ALLOWED_PATH_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(prefix)
  )
}

function shouldScanFileForSymbols(filePath) {
  if (isAllowedPath(filePath)) return false
  if (isLegacyIsolatedPath(filePath)) return false
  return true
}

function listFiles(dir) {
  const absDir = join(root, dir)
  if (!existsSync(absDir)) return []

  const entries = readdirSync(absDir, { withFileTypes: true })
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
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) continue
    files.push(relPath)
  }

  return files
}

function resolveImport(fromFile, specifier) {
  if (!specifier || specifier.startsWith('node:')) return null
  if (!specifier.startsWith('.') && !specifier.startsWith('@')) return null

  for (const [alias, target] of PATH_ALIASES) {
    if (specifier.startsWith(alias)) {
      const candidate = join(root, target, specifier.slice(alias.length))
      return resolveTypeScriptFile(candidate)
    }
  }

  if (specifier.startsWith('.')) {
    const candidate = resolve(dirname(join(root, fromFile)), specifier)
    return resolveTypeScriptFile(candidate)
  }

  return null
}

function resolveTypeScriptFile(basePath) {
  const candidates = [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    join(basePath, 'index.ts'),
    join(basePath, 'index.tsx')
  ]
  if (basePath.endsWith('.ts') || basePath.endsWith('.tsx')) {
    candidates.unshift(basePath)
  }
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const stats = statSync(candidate)
    if (!stats.isFile()) continue
    if (candidate.startsWith(join(root, 'src'))) {
      return normalizePath(relative(root, candidate))
    }
  }
  return null
}

function extractImportSpecifiers(source, { includeDynamic = false } = {}) {
  const specifiers = []
  const patterns = [/\bfrom\s+['"]([^'"]+)['"]/g, /\bimport\s+['"]([^'"]+)['"]/g]
  if (includeDynamic) {
    patterns.push(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)
  }
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      specifiers.push(match[1])
    }
  }
  return specifiers
}

function collectImportGraph(entrypoints, { includeDynamic = false } = {}) {
  const files = new Set()
  const queue = entrypoints.filter((entry) => existsSync(join(root, entry)))

  while (queue.length > 0) {
    const relPath = queue.pop()
    if (!relPath || files.has(relPath)) continue
    files.add(relPath)

    const absPath = join(root, relPath)
    if (!existsSync(absPath)) continue
    const source = readFileSync(absPath, 'utf8')
    for (const specifier of extractImportSpecifiers(source, { includeDynamic })) {
      const resolved = resolveImport(relPath, specifier)
      if (resolved && !files.has(resolved)) {
        queue.push(resolved)
      }
    }
  }

  return [...files]
}

function findMatches(pattern, filePath) {
  const regex = new RegExp(pattern)
  const text = readFileSync(join(root, filePath), 'utf8')
  const lines = text.split(/\r?\n/)
  const matches = []

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
        file: normalizePath(filePath),
        line: index + 1,
        text: line
      })
    }
  }

  return matches
}

const symbols = loadSymbols()
const v3CompositionGraph = collectImportGraph(V3_COMPOSITION_ENTRYPOINTS)
const bootstrapGraph = collectImportGraph(BOOTSTRAP_ENTRYPOINTS)
const scanTargets = new Set([
  ...SEARCH_ROOTS.flatMap((searchRoot) => listFiles(searchRoot)),
  ...v3CompositionGraph,
  ...bootstrapGraph
])

let hasErrors = false

for (const symbol of symbols) {
  for (const filePath of scanTargets) {
    if (!shouldScanFileForSymbols(filePath)) continue
    const matches = findMatches(symbol, filePath)
    if (matches.length === 0) continue
    hasErrors = true
    console.error(`\nForbidden legacy symbol "${symbol}" found outside allowed paths:`)
    for (const entry of matches) {
      console.error(`  ${entry.file}:${entry.line}: ${entry.text.trim()}`)
    }
  }
}

const legacyImports = v3CompositionGraph.filter((filePath) => isLegacyIsolatedPath(filePath))
if (legacyImports.length > 0) {
  hasErrors = true
  console.error('\nForbidden legacy-control-plane import in V3 composition graph:')
  for (const filePath of legacyImports) {
    console.error(`  ${filePath}`)
  }
}

if (hasErrors) {
  console.error('\n❌ legacy write guard failed')
  exit(1)
}

console.log(
  `✅ legacy write guard passed (${scanTargets.size} files scanned; composition graph clean)`
)
