import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findExecutable } from '../../scripts/package-smoke.mjs'

test('package smoke resolves the application executable instead of a bundled helper', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-smoke-layout-'))
  try {
    const linux = join(root, 'linux-unpacked')
    mkdirSync(linux)
    writeFileSync(join(linux, 'chrome-sandbox'), '')
    writeFileSync(join(linux, 'codetask'), '')
    assert.equal(findExecutable(root, 'linux'), join(linux, 'codetask'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package smoke resolves exact Windows and macOS application names', () => {
  const windowsRoot = mkdtempSync(join(tmpdir(), 'package-smoke-win-'))
  const macRoot = mkdtempSync(join(tmpdir(), 'package-smoke-mac-'))
  try {
    const windows = join(windowsRoot, 'win-unpacked')
    mkdirSync(windows)
    writeFileSync(join(windows, 'codetask.exe'), '')
    assert.equal(findExecutable(windowsRoot, 'win32'), join(windows, 'codetask.exe'))

    const macos = join(macRoot, 'mac-arm64', 'codetask.app', 'Contents', 'MacOS')
    mkdirSync(macos, { recursive: true })
    writeFileSync(join(macos, 'codetask'), '')
    assert.equal(findExecutable(macRoot, 'darwin'), join(macos, 'codetask'))
  } finally {
    rmSync(windowsRoot, { recursive: true, force: true })
    rmSync(macRoot, { recursive: true, force: true })
  }
})
