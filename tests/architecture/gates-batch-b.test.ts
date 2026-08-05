/**
 * Batch B architecture gates (Phase 0).
 * Freezes known debt; fails on NEW Electron/env/old-contract violations.
 * Product CODETASK_* clearance completed in Batch E (allowlist = host-environment only).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '../..')

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'out') continue
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|mjs|js|vue)$/.test(name)) files.push(full)
  }
  return files
}

function isCommentOrDoc(trimmed: string): boolean {
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/**') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('/*')
  )
}

function rel(file: string): string {
  return relative(root, file).split('\\').join('/')
}

/** Core packages + server must never import Electron (desktop app is the only host). */
const ELECTRON_BAN_ROOTS = [
  join(root, 'packages/server-core'),
  join(root, 'packages/database'),
  join(root, 'packages/contracts'),
  join(root, 'packages/agent-runtime'),
  join(root, 'src/server')
]

/**
 * Known process.env readers retained after Batch E product clearance.
 * Only Provider host-environment snapshot may read process.env in product code.
 */
const PROCESS_ENV_BASELINE_ALLOWLIST = new Set(['packages/agent-runtime/src/host-environment.ts'])

const PROCESS_ENV_SCAN_ROOTS = [
  join(root, 'packages'),
  join(root, 'apps/web'),
  join(root, 'apps/service'),
  join(root, 'apps/desktop'),
  join(root, 'src/server')
]

const PROCESS_ENV_SCAN_FILES = [
  join(root, 'electron.vite.config.ts'),
  join(root, 'electron.vite.standalone.config.ts')
]

/**
 * Renderer files currently importing @shared/contracts (Batch H will shrink this).
 * New importers fail the gate.
 */
const SHARED_CONTRACTS_BASELINE: string[] = []

describe('architecture gates — Batch B', () => {
  it('core packages and src/server do not import electron', () => {
    const offenders: string[] = []
    for (const banRoot of ELECTRON_BAN_ROOTS) {
      for (const file of walk(banRoot)) {
        const source = readFileSync(file, 'utf8')
        if (/from ['"]electron['"]|require\(['"]electron['"]\)/.test(source)) {
          offenders.push(rel(file))
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n') || 'no electron imports')
  })

  it('process.env readers stay within Batch B baseline allowlist', () => {
    const files = [
      ...PROCESS_ENV_SCAN_ROOTS.flatMap((dir) => walk(dir)),
      ...PROCESS_ENV_SCAN_FILES.filter((f) => existsSync(f))
    ]
    const offenders: string[] = []

    for (const file of files) {
      const path = rel(file)
      const lines = readFileSync(file, 'utf8').split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i] ?? ''
        const trimmed = text.trim()
        if (!/process\.env\b/.test(text) || isCommentOrDoc(trimmed)) continue
        if (PROCESS_ENV_BASELINE_ALLOWLIST.has(path)) continue
        offenders.push(`${path}:${i + 1}: ${trimmed}`)
      }
    }

    assert.deepEqual(offenders, [], offenders.join('\n') || 'no new process.env readers')
  })

  it('renderer does not import @shared/contracts (Batch H)', () => {
    const rendererRoot = join(root, 'apps/web')
    const found: string[] = []
    for (const file of walk(rendererRoot)) {
      const source = readFileSync(file, 'utf8')
      if (/@shared\/contracts/.test(source)) {
        found.push(rel(file))
      }
    }
    found.sort()
    assert.deepEqual(
      found,
      SHARED_CONTRACTS_BASELINE,
      ['found unexpected @shared/contracts importers:', ...found].join('\n')
    )
  })
})
