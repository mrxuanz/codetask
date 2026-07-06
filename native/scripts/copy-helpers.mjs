#!/usr/bin/env node

/**
 * Copy platform sandbox helper binaries next to the NAPI addon for packaging.
 * Windows uses the desktop host (Electron/Node + .node) — no standalone helper exes.
 */
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const targetDir = join(root, 'codeteam-sandbox', 'helpers')
const cargoTarget = join(root, 'target', 'release')
const cargoTargetDebug = join(root, 'target', 'debug')
mkdirSync(targetDir, { recursive: true })
function pickSource(name) {
  const release = join(cargoTarget, name)
  if (existsSync(release)) return release
  const debug = join(cargoTargetDebug, name)
  if (existsSync(debug)) return debug
  return null
}

const platform = process.platform
const copies = []
if (platform === 'linux') {
  copies.push(['codeteam-linux-sandbox', 'codeteam-linux-sandbox'])
} else if (platform === 'win32') {
  console.log('[copy-helpers] Windows: using desktop host launcher (no standalone .exe helpers)')
}

let copied = 0
for (const [srcName, destName] of copies) {
  const src = pickSource(srcName)
  if (!src) {
    console.warn(`[copy-helpers] skip missing ${srcName}`)
    continue
  }
  const dest = join(targetDir, destName)
  copyFileSync(src, dest)
  console.log(`[copy-helpers] ${src} -> ${dest}`)
  copied++
}

if (copied === 0 && platform !== 'win32') {
  console.warn('[copy-helpers] no helpers copied; run `cargo build --release` in native/ first')
}
