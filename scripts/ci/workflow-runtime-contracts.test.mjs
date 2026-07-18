import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const buildWorkflow = readFileSync(
  new URL('../../.github/workflows/build.yml', import.meta.url),
  'utf8'
)
const ciWorkflow = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const sandboxWorkflow = readFileSync(
  new URL('../../.github/workflows/sandbox.yml', import.meta.url),
  'utf8'
)

const serialRustTest =
  'cargo test --manifest-path native/Cargo.toml --no-fail-fast -- --test-threads=1'

test('Linux package smoke runs Electron under a virtual display', () => {
  assert.match(buildWorkflow, /inputs\.smoke-unpacked && runner\.os == 'Linux'/)
  assert.match(
    buildWorkflow,
    /xvfb-run --auto-servernum node scripts\/package-smoke\.mjs --dist dist/
  )
  assert.match(buildWorkflow, /inputs\.smoke-unpacked && runner\.os != 'Linux'/)
})

test('Rust workspace tests are serialized without skipping failures', () => {
  assert.ok(ciWorkflow.includes(serialRustTest))
  assert.ok(sandboxWorkflow.includes(serialRustTest))
  assert.match(
    sandboxWorkflow,
    /cargo test --manifest-path native\/Cargo\.toml --release --no-fail-fast -- --test-threads=1/
  )
})
