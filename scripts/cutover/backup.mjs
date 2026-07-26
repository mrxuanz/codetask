#!/usr/bin/env node
/**
 * Wave 9 cutover step 3: backup DB + artifact manifest.
 *
 * Copies the SQLite database file and the artifact manifest into --out.
 * Does not modify source files. Safe for fixture rehearsal; operators must
 * explicitly choose production paths for real cutover.
 *
 * Usage:
 *   node scripts/cutover/backup.mjs --db <app.db> --artifacts <manifest> --out <backup-dir>
 */

import { copyFileSync, cpSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fail, parseArgs, printJson, requireArg } from './lib.mjs'

function sha256File(path) {
  const hash = createHash('sha256')
  hash.update(readFileSync(path))
  return hash.digest('hex')
}

function copyPath(src, dest) {
  const st = statSync(src)
  if (st.isDirectory()) {
    cpSync(src, dest, { recursive: true })
    return { kind: 'directory' }
  }
  copyFileSync(src, dest)
  return { kind: 'file', sha256: sha256File(src), bytes: st.size }
}

function main() {
  try {
    const args = parseArgs()
    const dbPath = requireArg(args, 'db')
    const artifactsPath = requireArg(args, 'artifacts')
    const outDir = requireArg(args, 'out')

    if (!existsSync(dbPath)) throw new Error(`db not found: ${dbPath}`)
    if (!existsSync(artifactsPath)) throw new Error(`artifacts not found: ${artifactsPath}`)

    mkdirSync(outDir, { recursive: true })
    const dbDest = join(outDir, basename(dbPath))
    const artifactsDest = join(outDir, basename(artifactsPath))

    const dbMeta = copyPath(dbPath, dbDest)
    const artifactsMeta = copyPath(artifactsPath, artifactsDest)

    const manifest = {
      ok: true,
      step: 'backup',
      createdAtMs: Date.now(),
      source: { db: dbPath, artifacts: artifactsPath },
      backup: {
        out: outDir,
        db: dbDest,
        artifacts: artifactsDest,
        dbMeta,
        artifactsMeta
      }
    }
    writeFileSync(join(outDir, 'backup-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
    printJson(manifest)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

main()
