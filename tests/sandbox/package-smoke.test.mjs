import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findExecutable } from '../../scripts/package-smoke.mjs'

test('package smoke resolves the package-named Linux executable instead of bundled helpers', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-smoke-layout-'))
  try {
    const linux = join(root, 'linux-unpacked')
    mkdirSync(linux)
    writeFileSync(join(linux, 'chrome-sandbox'), '')
    writeFileSync(join(linux, 'chrome_crashpad_handler'), '')
    writeFileSync(join(linux, 'task'), '')
    assert.equal(findExecutable(root, 'linux'), join(linux, 'task'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package smoke accepts an explicit product-named Linux executable', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-smoke-product-layout-'))
  try {
    const linux = join(root, 'linux-unpacked')
    mkdirSync(linux)
    writeFileSync(join(linux, 'codetask'), '')
    assert.equal(findExecutable(root, 'linux'), join(linux, 'codetask'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('package smoke reports expected and available Linux executables', () => {
  const root = mkdtempSync(join(tmpdir(), 'package-smoke-missing-layout-'))
  try {
    const linux = join(root, 'linux-unpacked')
    mkdirSync(linux)
    writeFileSync(join(linux, 'chrome-sandbox'), '')
    assert.throws(
      () => findExecutable(root, 'linux'),
      /package_smoke\.executable_missing:.*:expected=task,codetask:available=chrome-sandbox/
    )
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
