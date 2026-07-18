import assert from 'node:assert/strict'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it } from 'node:test'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')

const COMPOSITION_ENTRYPOINTS = [
  'src/server/application/application-runtime.ts',
  'src/server/application/control-plane-runtime.ts',
  'src/server/application/control-plane-services.ts'
]

const PATH_ALIASES = new Map([['@shared/', 'src/shared/']])

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, '/')
}

function resolveTypeScriptFile(basePath: string): string | null {
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
    if (candidate.includes(`${join(repoRoot, 'src')}`)) {
      return normalizePath(candidate.slice(repoRoot.length + 1))
    }
  }
  return null
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier || specifier.startsWith('node:')) return null
  if (!specifier.startsWith('.') && !specifier.startsWith('@')) return null

  for (const [alias, target] of PATH_ALIASES) {
    if (specifier.startsWith(alias)) {
      const candidate = join(repoRoot, target, specifier.slice(alias.length))
      return resolveTypeScriptFile(candidate)
    }
  }

  if (specifier.startsWith('.')) {
    const candidate = resolve(join(repoRoot, fromFile, '..'), specifier)
    return resolveTypeScriptFile(candidate)
  }

  return null
}

function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1]
      if (specifier) specifiers.push(specifier)
    }
  }
  return specifiers
}

function collectCompositionImportGraph(): string[] {
  const files = new Set<string>()
  const queue = COMPOSITION_ENTRYPOINTS.filter((entry) => existsSync(join(repoRoot, entry)))

  while (queue.length > 0) {
    const relPath = queue.pop()
    if (!relPath || files.has(relPath)) continue
    files.add(relPath)

    const absPath = join(repoRoot, relPath)
    const source = readFileSync(absPath, 'utf8')
    for (const specifier of extractImportSpecifiers(source)) {
      const resolved = resolveImport(relPath, specifier)
      if (resolved && !files.has(resolved)) {
        queue.push(resolved)
      }
    }
  }

  return [...files]
}

describe('composition: authoritative V3 import closure', () => {
  it('production V3 composition root must not import legacy-control-plane', () => {
    const graph = collectCompositionImportGraph()
    const offenders = graph.filter((filePath) => filePath.includes('legacy-control-plane/'))
    assert.deepEqual(
      offenders,
      [],
      `V3 composition graph must not depend on legacy-control-plane: ${offenders.join(', ')}`
    )
  })
})
