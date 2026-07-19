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
const releaseWorkflow = readFileSync(
  new URL('../../.github/workflows/release.yml', import.meta.url),
  'utf8'
)
const nodeVersion = readFileSync(new URL('../../.node-version', import.meta.url), 'utf8').trim()

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

test('standalone Node smoke runs separately from the Electron display smoke', () => {
  assert.match(buildWorkflow, /Smoke standalone Node service without a display/)
  assert.match(buildWorkflow, /npm run smoke:standalone:ci/)
  assert.match(buildWorkflow, /standalone-smoke\.log/)
})

test('release builds package and smoke an ncc + SEA service artifact', () => {
  assert.match(buildWorkflow, /Package ncc \+ SEA standalone service/)
  assert.match(buildWorkflow, /npm run package:server:sea/)
  assert.match(buildWorkflow, /server-sea-smoke\.log/)
  assert.match(buildWorkflow, /dist\/\*\.tar\.gz/)
})

test('CI package-smoke passes a real platform label for SEA packaging', () => {
  assert.match(
    ciWorkflow,
    /package-smoke:[\s\S]*?artifact-name:\s*linux-amd64/u
  )
  assert.match(
    buildWorkflow,
    /npm run package:server:sea -- --platform \$\{\{ inputs\.artifact-name \}\}/u
  )
})

test('CI and release use Node 24 LTS from one version file', () => {
  assert.equal(nodeVersion, '24')
  for (const workflow of [buildWorkflow, ciWorkflow, sandboxWorkflow, releaseWorkflow]) {
    assert.match(workflow, /node-version-file: \.node-version/u)
    assert.doesNotMatch(workflow, /node-version:\s*['"]?22/u)
  }
})

test('release validates its source and requires all six native target builds', () => {
  assert.match(releaseWorkflow, /scripts\/resolve-release-source\.mjs/u)
  assert.match(releaseWorkflow, /target_commitish: \$\{\{ needs\.prepare\.outputs\.sha \}\}/u)
  const targets = [
    ['ubuntu-24.04', 'linux-amd64'],
    ['ubuntu-24.04-arm', 'linux-arm64'],
    ['macos-15-intel', 'macos-amd64'],
    ['macos-15', 'macos-arm64'],
    ['windows-2025', 'windows-amd64'],
    ['windows-11-arm', 'windows-arm64']
  ]
  for (const [runner, platform] of targets) {
    assert.ok(releaseWorkflow.includes(`runner: ${runner}`))
    assert.ok(releaseWorkflow.includes(`name: ${platform}`))
  }
  assert.match(releaseWorkflow, /name: \$\{\{ matrix\.name \}\}/u)
  assert.match(buildWorkflow, /name: Normalize public release artifact names/u)
  assert.doesNotMatch(releaseWorkflow, /name: (?:linux|macos|windows)-x64/u)
})

test('Rust workspace tests are serialized without skipping failures', () => {
  assert.ok(ciWorkflow.includes(serialRustTest))
  assert.ok(sandboxWorkflow.includes(serialRustTest))
  assert.match(
    sandboxWorkflow,
    /cargo test --manifest-path native\/Cargo\.toml --release --no-fail-fast -- --test-threads=1/
  )
})
