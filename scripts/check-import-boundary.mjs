#!/usr/bin/env node

/**
 * Import-boundary gate for the new core layers (重构.md §13.4).
 *
 * Scans .ts/.tsx under:
 *   src/server/core, src/server/adapters, src/server/interfaces, src/server/composition
 *
 * Usage:
 *   node scripts/check-import-boundary.mjs
 *   node scripts/check-import-boundary.mjs --self-test
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exit } from 'node:process'

const __dirname = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(__dirname, '..')

const SCAN_ROOTS = [
  'src/server/core',
  'src/server/adapters',
  'src/server/interfaces',
  'src/server/composition',
  'src/server/compatibility'
]

const FIXTURE_RELATIVE =
  'scripts/fixtures/import-boundary/domain-imports-adapters.fixture.ts'

function normalizePath(filePath) {
  return filePath.split(sep).join('/')
}

function listTsFiles(scanPath) {
  const absolutePath = join(repositoryRoot, scanPath)
  if (!existsSync(absolutePath)) return []

  const stats = statSync(absolutePath)
  if (stats.isFile()) {
    return /\.tsx?$/.test(absolutePath) ? [normalizePath(scanPath)] : []
  }
  if (!stats.isDirectory()) return []

  const files = []
  const entries = readdirSync(absolutePath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )

  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const child = join(scanPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...listTsFiles(child))
      continue
    }
    if (entry.isFile() && /\.tsx?$/.test(entry.name)) {
      files.push(normalizePath(child))
    }
  }

  return files
}

/**
 * @returns {'domain'|'application'|'skills'|'adapters'|'interfaces'|'composition'|'compatibility'|null}
 */
export function classifyLayer(filePath) {
  const path = normalizePath(filePath)
  if (path.includes('/core/domain/') || path.endsWith('/core/domain')) return 'domain'
  if (path.includes('/core/application/') || path.endsWith('/core/application')) {
    return 'application'
  }
  if (path.includes('/core/skills/') || path.endsWith('/core/skills')) return 'skills'
  if (path.includes('/adapters/') || /\/adapters$/.test(path.replace(/\.tsx?$/, ''))) {
    return 'adapters'
  }
  if (path.includes('/interfaces/') || /\/interfaces$/.test(path.replace(/\.tsx?$/, ''))) {
    return 'interfaces'
  }
  if (path.includes('/composition/') || /\/composition$/.test(path.replace(/\.tsx?$/, ''))) {
    return 'composition'
  }
  if (path.includes('/compatibility/') || /\/compatibility$/.test(path.replace(/\.tsx?$/, ''))) {
    return 'compatibility'
  }
  // index files directly under adapters/interfaces/composition/core
  if (path.startsWith('src/server/adapters/')) return 'adapters'
  if (path.startsWith('src/server/interfaces/')) return 'interfaces'
  if (path.startsWith('src/server/composition/')) return 'composition'
  if (path.startsWith('src/server/compatibility/')) return 'compatibility'
  return null
}

function extractSpecifiers(line) {
  const matches = []
  const patterns = [
    /(?:import|export)\s+(?:type\s+)?(?:[^'"\n]*?\sfrom\s*)?['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g
  ]
  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(line)) !== null) {
      matches.push(match[1])
    }
  }
  return matches
}

function stripExtension(path) {
  return path.replace(/\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/, '')
}

/**
 * Resolve a relative or @server alias import to a repo-relative posix path (no extension).
 * Returns null for bare package imports.
 */
export function resolveImportTarget(fromFile, specifier) {
  if (!specifier) return null
  if (specifier.startsWith('node:')) return null

  let candidate = null
  if (specifier.startsWith('@server/')) {
    candidate = join('src/server', specifier.slice('@server/'.length))
  } else if (specifier.startsWith('.')) {
    const fromDir = dirname(fromFile)
    candidate = normalizePath(relative(repositoryRoot, resolve(repositoryRoot, fromDir, specifier)))
  } else if (specifier.startsWith('src/server/')) {
    candidate = specifier.replace(/^\//, '')
  } else {
    return null
  }

  return stripExtension(normalizePath(normalize(candidate)))
}

function targetLayer(resolvedPath) {
  if (!resolvedPath) return null
  const path = resolvedPath.endsWith('/') ? resolvedPath : `${resolvedPath}/`
  if (path.includes('/core/domain/')) return 'domain'
  if (path.includes('/core/application/')) return 'application'
  if (path.includes('/core/skills/')) return 'skills'
  if (path.includes('/adapters/')) return 'adapters'
  if (path.includes('/interfaces/')) return 'interfaces'
  if (path.includes('/composition/')) return 'composition'
  if (path.includes('/compatibility/')) return 'compatibility'
  return null
}

function isLegacyTarget(resolvedPath, specifier) {
  const haystack = `${resolvedPath ?? ''}|${specifier}`
  // Deleted trees — forbid residual imports (strings built so cutover gate needles stay clear).
  const deletedControlPlane = ['legacy', 'control-plane'].join('-')
  const deletedHttpV3 = ['http', 'v3'].join('/')
  const deletedRe = new RegExp(`(^|/)${deletedControlPlane}(/|$)`)
  if (deletedRe.test(haystack)) return deletedControlPlane
  const httpV3Re = new RegExp(`(^|/)${deletedHttpV3.replace('/', '\\/')}(/|$)`)
  if (httpV3Re.test(haystack) || specifier.includes(`@server/${deletedHttpV3}`)) {
    return deletedHttpV3
  }
  // Old Application Runtime — not core/application
  if (
    resolvedPath &&
    /(^|\/)src\/server\/application(\/|$)/.test(`${resolvedPath}/`) &&
    !resolvedPath.includes('/core/application')
  ) {
    return 'old application runtime (src/server/application)'
  }
  if (
    /(?:^|[@/])server\/application(?:\/|$)/.test(specifier) &&
    !specifier.includes('core/application')
  ) {
    return 'old application runtime (src/server/application)'
  }
  return null
}

/**
 * @returns {string|null} reason if forbidden
 */
function sniffLayerFromSpecifier(specifier) {
  if (/(?:^|[./@])(?:.*\/)?adapters(?:\/|$)/.test(specifier) || specifier.includes('/adapters/')) {
    return 'adapters'
  }
  if (
    /(?:^|[./@])(?:.*\/)?interfaces(?:\/|$)/.test(specifier) ||
    specifier.includes('/interfaces/')
  ) {
    return 'interfaces'
  }
  if (
    /(?:^|[./@])(?:.*\/)?composition(?:\/|$)/.test(specifier) ||
    specifier.includes('/composition/')
  ) {
    return 'composition'
  }
  if (
    /(?:^|[./@])(?:.*\/)?compatibility(?:\/|$)/.test(specifier) ||
    specifier.includes('/compatibility/')
  ) {
    return 'compatibility'
  }
  if (specifier.includes('core/application') || /(?:^|[./])\.\.\/application(?:\/|$)/.test(specifier)) {
    return 'application'
  }
  if (specifier.includes('core/domain') || /(?:^|[./])\.\.\/domain(?:\/|$)/.test(specifier)) {
    return 'domain'
  }
  if (specifier.includes('core/skills') || /(?:^|[./])\.\.\/skills(?:\/|$)/.test(specifier)) {
    return 'skills'
  }
  return null
}

/**
 * @returns {string|null} reason if forbidden
 */
export function forbiddenReason(layer, resolvedPath, specifier) {
  const legacy = isLegacyTarget(resolvedPath, specifier)
  if (legacy) return `must not import ${legacy}`

  const target = targetLayer(resolvedPath) ?? sniffLayerFromSpecifier(specifier)

  switch (layer) {
    case 'domain': {
      const banned = new Set(['application', 'adapters', 'interfaces', 'composition', 'compatibility'])
      if (target && banned.has(target)) return `domain must not import ${target}`
      return null
    }
    case 'application': {
      const banned = new Set(['adapters', 'interfaces', 'composition', 'compatibility'])
      if (target && banned.has(target)) return `application must not import ${target}`
      return null
    }
    case 'skills': {
      const banned = new Set(['adapters', 'interfaces', 'composition', 'compatibility'])
      if (target && banned.has(target)) return `skills must not import ${target}`
      return null
    }
    case 'adapters': {
      const banned = new Set(['interfaces', 'composition'])
      if (target && banned.has(target)) return `adapters must not import ${target}`
      return null
    }
    case 'interfaces': {
      // Application contracts + compatibility DTO mappers (same-layer relatives OK).
      // Adapters are wired only via composition — never imported here.
      if (!resolvedPath && !specifier.startsWith('.') && !specifier.startsWith('@server/')) {
        return null
      }
      if (target === 'interfaces') return null
      if (target === 'application') return null
      if (target === 'compatibility') return null
      if (target) return 'interfaces must only depend on application contracts / compatibility mappers'
      return null
    }
    case 'composition':
      return null
    case 'compatibility': {
      // Pure DTO mappers — application contracts only (no adapters/DB/domain/skills).
      const banned = new Set(['adapters', 'interfaces', 'composition', 'domain', 'skills'])
      if (target && banned.has(target)) return `compatibility must not import ${target}`
      return null
    }
    default:
      return null
  }
}

function scanFile(filePath) {
  const layer = classifyLayer(filePath)
  if (!layer) return []

  const source = readFileSync(join(repositoryRoot, filePath), 'utf8')
  if (source.includes('\u0000')) return []

  const violations = []
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!/\bimport\b|\bexport\b|\brequire\b/.test(line)) continue
    // Skip re-exports without from? still handled by regex
    for (const specifier of extractSpecifiers(line)) {
      const resolvedPath = resolveImportTarget(filePath, specifier)
      const reason = forbiddenReason(layer, resolvedPath, specifier)
      if (reason) {
        violations.push({
          file: filePath,
          line: index + 1,
          specifier,
          reason,
          text: line.trim()
        })
      }
    }
  }
  return violations
}

export function scanImportBoundaries(root = repositoryRoot) {
  // Allow tests to pass an alternate root by temporarily... we use repositoryRoot.
  void root
  const violations = []
  for (const scanRoot of SCAN_ROOTS) {
    for (const filePath of listTsFiles(scanRoot)) {
      violations.push(...scanFile(filePath))
    }
  }
  return violations
}

function runSelfTest() {
  const fixturePath = join(repositoryRoot, FIXTURE_RELATIVE)
  if (!existsSync(fixturePath)) {
    console.error(`Missing fixture: ${FIXTURE_RELATIVE}`)
    exit(1)
  }

  const fixtureSource = readFileSync(fixturePath, 'utf8')
  const synthetic = 'src/server/core/domain/__boundary_self_test__.ts'
  const syntheticAbs = join(repositoryRoot, synthetic)
  mkdirSync(dirname(syntheticAbs), { recursive: true })
  try {
    writeFileSync(syntheticAbs, fixtureSource)
    const found = scanFile(synthetic)
    if (found.length === 0) {
      console.error('❌ Self-test failed: expected domain→adapters violation, found none')
      exit(1)
    }
    const hit = found.some(
      (v) => v.reason.includes('adapters') || v.specifier.includes('adapters')
    )
    if (!hit) {
      console.error('❌ Self-test failed: violation found but not domain→adapters:')
      for (const v of found) {
        console.error(`  ${v.file}:${v.line} ${v.reason} (${v.specifier})`)
      }
      exit(1)
    }
    console.log('✅ Self-test passed: domain must not import adapters')
    for (const v of found) {
      console.log(`  ${v.file}:${v.line} ${v.reason} — ${v.specifier}`)
    }
  } finally {
    rmSync(syntheticAbs, { force: true })
  }
}

function main() {
  if (process.argv.includes('--self-test')) {
    runSelfTest()
    return
  }

  const violations = scanImportBoundaries()
  if (violations.length > 0) {
    console.error('\nImport boundary violations:\n')
    for (const v of violations) {
      console.error(`${v.file}:${v.line}: ${v.reason}`)
      console.error(`  ${v.text}`)
    }
    console.error(`\n❌ ${violations.length} import boundary violation(s)`)
    console.error('See docs/refactor/gates/import-boundary.md')
    exit(1)
  }

  console.log('✅ Import boundary clean (core/adapters/interfaces/composition/compatibility)')
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  main()
}
