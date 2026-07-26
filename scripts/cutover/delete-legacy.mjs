#!/usr/bin/env node
/**
 * Gated legacy purge for Wave 10 (重构.md §15.12 / T309–T314) + Phase D execute.
 *
 * SAFETY:
 * - Refuses to delete while any import-graph hits remain (exit 1).
 * - Physical delete runs only when the gate is clear AND `--execute` is passed.
 * - `--force-dry-run` prints candidate paths without deleting.
 *
 * Usage:
 *   node scripts/cutover/delete-legacy.mjs
 *   node scripts/cutover/delete-legacy.mjs --force-dry-run
 *   node scripts/cutover/delete-legacy.mjs --json
 *   node scripts/cutover/delete-legacy.mjs --execute
 */

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { fail, parseArgs, printJson, REPO_ROOT } from './lib.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** Content needles that block deletion until count is zero. */
export const IMPORT_NEEDLES = [
  'legacy-control-plane',
  'http/v3',
  'v3_authoritative'
]

/**
 * Paths removed once the gate is clear (Phase D narrow purge).
 *
 * Kept deliberately (still required by production / Phase B bridges):
 * - src/server/control-plane (relocated implementation)
 * - src/server/compatibility/legacy-api-mapper.ts
 * - src/server/compatibility/legacy-sse-mapper.ts
 * - src/server/application/cutover-state.ts
 * - src/server/http/legacy-cutover-guard.ts
 * - scripts/control-plane/cutover-marker.ts
 */
export const DELETE_CANDIDATES = [
  'src/server/http/v3',
  'scripts/control-plane/cutover.ts'
]

const INVENTORY_DRIVEN = [
  'T313: credential-materializer / runtime-copy remnants (inventory-driven)',
  'T314: unprotected spawn paths (inventory-driven)'
]

const EXCLUDE_PREFIXES = [
  'node_modules/',
  '.git/',
  'dist/',
  'out/',
  'docs/',
  // Target trees (self-hits while still on disk are ignored)
  'src/server/http/v3/'
]

const EXCLUDE_EXACT = new Set([
  '重构.md',
  'scripts/cutover/delete-legacy.mjs',
  'scripts/cutover/README.md',
  'tests/core/cutover/delete-legacy-gate.test.ts'
])

function toPosix(p) {
  let out = p.split(sep).join('/')
  while (out.startsWith('./')) out = out.slice(2)
  if (out.startsWith('/')) {
    // absolute paths from tools — relativize when under repo
    const rel = toPosix(relative(REPO_ROOT, out))
    if (rel && !rel.startsWith('..')) out = rel
  }
  return out
}

function isExcluded(relPosix) {
  const rel = toPosix(relPosix)
  if (EXCLUDE_EXACT.has(rel)) return true
  return EXCLUDE_PREFIXES.some(
    (prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix)
  )
}

function walkMatch(repoRoot, needle, dir = repoRoot, acc = []) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return acc
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out') {
      continue
    }
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    const rel = toPosix(relative(repoRoot, abs))
    if (st.isDirectory()) {
      walkMatch(repoRoot, needle, abs, acc)
      continue
    }
    if (!/\.(ts|tsx|mjs|js|cjs|vue|md)$/.test(name)) continue
    if (isExcluded(rel)) continue
    try {
      if (readFileSync(abs, 'utf8').includes(needle)) acc.push(rel)
    } catch {
      /* skip unreadable */
    }
  }
  return acc
}

function findFilesWithNeedle(repoRoot, needle) {
  const rg = spawnSync(
    'rg',
    [
      '-l',
      '--fixed-strings',
      needle,
      '-g',
      '!node_modules/**',
      '-g',
      '!.git/**',
      '-g',
      '!dist/**',
      '-g',
      '!out/**',
      '.'
    ],
    { cwd: repoRoot, encoding: 'utf8' }
  )
  if (!rg.error && (rg.status === 0 || rg.status === 1)) {
    return (rg.stdout || '')
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((p) => toPosix(p))
  }
  return walkMatch(repoRoot, needle)
}

export function summarizeImportGraph(repoRoot = REPO_ROOT) {
  const rows = IMPORT_NEEDLES.map((needle) => {
    const files = findFilesWithNeedle(repoRoot, needle)
      .filter((f) => !isExcluded(f))
      .sort()
    return { needle, count: files.length, files }
  })
  const total = rows.reduce((n, r) => n + r.count, 0)
  return { rows, total, blocked: total > 0 }
}

function listExistingCandidates(repoRoot = REPO_ROOT) {
  const paths = DELETE_CANDIDATES.map((rel) => ({
    path: rel,
    exists: existsSync(join(repoRoot, rel)),
    note: null
  }))
  for (const note of INVENTORY_DRIVEN) {
    paths.push({ path: note, exists: null, note: 'inventory-driven' })
  }
  return paths
}

function deleteCandidate(repoRoot, rel) {
  const abs = join(repoRoot, rel)
  if (!existsSync(abs)) return { path: rel, deleted: false, reason: 'missing' }
  rmSync(abs, { recursive: true, force: true })
  return { path: rel, deleted: true, reason: null }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dryRun = Boolean(args['force-dry-run'])
  const execute = Boolean(args.execute)
  const json = Boolean(args.json)

  const graph = summarizeImportGraph(REPO_ROOT)
  const candidates = listExistingCandidates(REPO_ROOT)

  if (dryRun) {
    console.error(
      '[delete-legacy] --force-dry-run: candidates that WOULD be deleted when gate passes:'
    )
    for (const c of candidates) {
      if (c.exists === null) {
        console.error(`  - ${c.path}`)
      } else {
        console.error(`  - ${c.path} (exists=${c.exists})`)
      }
    }
  }

  if (json) {
    printJson({
      blocked: graph.blocked,
      total: graph.total,
      rows: graph.rows.map((r) => ({
        needle: r.needle,
        count: r.count,
        sample: r.files.slice(0, 10)
      })),
      candidates,
      dryRun,
      execute
    })
  }

  if (graph.blocked) {
    const samples = graph.rows
      .filter((r) => r.count > 0)
      .map((r) => `  ${r.needle}: ${r.count} file(s), e.g. ${r.files.slice(0, 3).join(', ')}`)
      .join('\n')
    fail(
      [
        '[delete-legacy] REFUSED: import graph is non-zero — physical delete is blocked.',
        `Total importer hits: ${graph.total}`,
        samples,
        'Deletion is blocked until zero importers remain.',
        'T309–T314 execute only when this gate passes.',
        'Re-run with --force-dry-run to print candidate paths without deleting.',
        'See docs/refactor/legacy-import-graph.md'
      ].join('\n'),
      1
    )
  }

  if (!execute) {
    console.log(
      '[delete-legacy] Gate clear (zero importers). Pass --execute to perform physical delete. No files deleted.'
    )
    process.exit(0)
  }

  const results = []
  for (const rel of DELETE_CANDIDATES) {
    results.push(deleteCandidate(REPO_ROOT, rel))
  }

  const deleted = results.filter((r) => r.deleted).map((r) => r.path)
  const missing = results.filter((r) => !r.deleted).map((r) => r.path)

  console.log('[delete-legacy] Physical purge complete.')
  for (const path of deleted) {
    console.log(`  deleted: ${path}`)
  }
  for (const path of missing) {
    console.log(`  skipped (missing): ${path}`)
  }
  console.log('Inventory-driven (not bulk-rm):')
  for (const note of INVENTORY_DRIVEN) {
    console.log(`  - ${note}`)
  }
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(join(HERE, 'delete-legacy.mjs'))

if (isMain) {
  try {
    main()
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err), 1)
  }
}
