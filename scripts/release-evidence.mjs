#!/usr/bin/env node

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

const SCHEMA_VERSION = 1
const REQUIRED_PLATFORMS = ['linux-x64', 'macos-arm64', 'windows-x64']
const ARTIFACT_EXTENSIONS = ['.exe', '.deb', '.AppImage', '.dmg', '.zip']
const PLATFORM_ARTIFACT_TOKEN = {
  'linux-x64': '-linux-',
  'macos-arm64': '-macos-',
  'windows-x64': '-windows-'
}

function values(argv, name) {
  const result = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === name && argv[index + 1]) result.push(argv[++index])
  }
  return result
}

function value(argv, name, required = true) {
  const result = values(argv, name).at(-1)
  if (required && !result) throw new Error(`release_evidence.argument_required:${name}`)
  return result
}

function assertCommit(commit) {
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error('release_evidence.invalid_commit')
}

function sha256File(path) {
  return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`
}

function normalizedRelative(root, path) {
  const output = relative(resolve(root), resolve(path)).split(sep).join('/')
  if (!output || output === '..' || output.startsWith('../')) {
    throw new Error(`release_evidence.path_outside_root:${path}`)
  }
  return output
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function commandVersion(command, args = ['--version']) {
  const actual = process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command
  const result = spawnSync(actual, args, { encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`release_evidence.toolchain_unavailable:${command}`)
  return result.stdout.trim().split(/\r?\n/u)[0]
}

function packageVersion(name) {
  return readJson(resolve('node_modules', name, 'package.json')).version
}

function collectToolchain() {
  return {
    node: process.version,
    npm: commandVersion('npm'),
    rustc: commandVersion('rustc'),
    electron: packageVersion('electron'),
    electronBuilder: packageVersion('electron-builder'),
    betterSqlite3: packageVersion('better-sqlite3'),
    runner: `${process.platform}-${process.arch}`
  }
}

function copyAndDescribeLogs(logPaths, evidenceRoot, destinationDir) {
  mkdirSync(destinationDir, { recursive: true })
  return logPaths.map((source) => {
    if (!existsSync(source)) throw new Error(`release_evidence.log_missing:${source}`)
    const destination = join(destinationDir, basename(source))
    if (resolve(source) !== resolve(destination)) copyFileSync(source, destination)
    return {
      path: normalizedRelative(evidenceRoot, destination),
      sha256: sha256File(destination),
      bytes: statSync(destination).size
    }
  })
}

function listArtifacts(distDir, platform) {
  const platformToken = PLATFORM_ARTIFACT_TOKEN[platform]
  return readdirSync(distDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.includes(platformToken) &&
        ARTIFACT_EXTENSIONS.some((extension) => entry.name.endsWith(extension))
    )
    .map((entry) => {
      const path = join(distDir, entry.name)
      return { name: entry.name, sha256: sha256File(path), bytes: statSync(path).size }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

function baseManifest(kind, commit, lockfile) {
  return {
    schemaVersion: SCHEMA_VERSION,
    kind,
    releaseGeneration: 'legacy',
    releaseCommit: commit,
    createdAt: new Date().toISOString(),
    toolchain: collectToolchain(),
    lockfile: { name: basename(lockfile), sha256: sha256File(lockfile) }
  }
}

function createTest(argv) {
  const commit = value(argv, '--commit')
  const output = value(argv, '--out')
  const lockfile = value(argv, '--lockfile')
  const evidenceRoot = value(argv, '--evidence-root')
  const logPaths = values(argv, '--log')
  assertCommit(commit)
  if (logPaths.length === 0) throw new Error('release_evidence.test_log_required')
  const logs = copyAndDescribeLogs(logPaths, evidenceRoot, dirname(output))
  writeJson(output, { ...baseManifest('legacy-test-gate', commit, lockfile), logs })
}

function createBuild(argv) {
  const commit = value(argv, '--commit')
  const platform = value(argv, '--platform')
  const distDir = value(argv, '--dist')
  const output = value(argv, '--out')
  const lockfile = value(argv, '--lockfile')
  const evidenceRoot = value(argv, '--evidence-root')
  const logPaths = values(argv, '--log')
  assertCommit(commit)
  if (!REQUIRED_PLATFORMS.includes(platform)) throw new Error('release_evidence.invalid_platform')
  if (logPaths.length === 0) throw new Error('release_evidence.build_log_required')
  const smokeLog = logPaths.find((path) => basename(path).includes('smoke'))
  if (!smokeLog || !readFileSync(smokeLog, 'utf8').includes('"ok":true')) {
    throw new Error('release_evidence.smoke_proof_missing')
  }
  const artifacts = listArtifacts(distDir, platform)
  if (artifacts.length === 0) throw new Error('release_evidence.artifact_missing')
  const logs = copyAndDescribeLogs(logPaths, evidenceRoot, dirname(output))
  const testManifestPath = join(evidenceRoot, 'release-evidence', 'test', 'test-gate.manifest.json')
  if (!existsSync(testManifestPath)) throw new Error('release_evidence.test_manifest_missing')
  writeJson(output, {
    ...baseManifest('legacy-platform-build', commit, lockfile),
    platform,
    testManifest: {
      path: normalizedRelative(evidenceRoot, testManifestPath),
      sha256: sha256File(testManifestPath),
      bytes: statSync(testManifestPath).size
    },
    logs,
    artifacts
  })
}

function walk(root) {
  const output = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) output.push(...walk(path))
    else output.push(path)
  }
  return output
}

function verifyDescription(root, description, label) {
  if (typeof description?.path !== 'string' || typeof description?.sha256 !== 'string') {
    throw new Error(`release_evidence.${label}_description_invalid`)
  }
  const path = resolve(root, description.path)
  normalizedRelative(root, path)
  if (!existsSync(path)) throw new Error(`release_evidence.${label}_missing:${description.path}`)
  if (
    sha256File(path) !== description.sha256 ||
    !Number.isInteger(description.bytes) ||
    statSync(path).size !== description.bytes
  ) {
    throw new Error(`release_evidence.${label}_hash_mismatch:${description.path}`)
  }
}

function verify(argv) {
  const root = value(argv, '--root')
  const commit = value(argv, '--commit')
  const lockfile = value(argv, '--lockfile')
  const reportPath = value(argv, '--report')
  assertCommit(commit)
  const expectedLockfileHash = sha256File(lockfile)
  const manifestPaths = walk(root)
    .filter((path) => path.endsWith('.manifest.json'))
    .sort()
  const manifests = manifestPaths.map((path) => ({ path, manifest: readJson(path) }))
  const testManifests = manifests.filter(({ manifest }) => manifest.kind === 'legacy-test-gate')
  const buildManifests = manifests.filter(
    ({ manifest }) => manifest.kind === 'legacy-platform-build'
  )
  if (testManifests.length !== 1) throw new Error('release_evidence.test_manifest_count')
  const platforms = buildManifests.map(({ manifest }) => manifest.platform).sort()
  if (JSON.stringify(platforms) !== JSON.stringify(REQUIRED_PLATFORMS)) {
    throw new Error(`release_evidence.platform_set_invalid:${platforms.join(',')}`)
  }

  const verifiedArtifacts = []
  const canonicalTestManifest = testManifests[0]
  const canonicalTestPath = normalizedRelative(root, canonicalTestManifest.path)
  const canonicalTestHash = sha256File(canonicalTestManifest.path)
  for (const { path, manifest } of manifests) {
    if (
      !['legacy-test-gate', 'legacy-platform-build'].includes(manifest.kind) ||
      manifest.schemaVersion !== SCHEMA_VERSION ||
      manifest.releaseGeneration !== 'legacy' ||
      manifest.releaseCommit !== commit ||
      manifest.lockfile?.sha256 !== expectedLockfileHash ||
      !manifest.toolchain ||
      typeof manifest.toolchain.node !== 'string' ||
      typeof manifest.toolchain.rustc !== 'string' ||
      !Array.isArray(manifest.logs) ||
      manifest.logs.length === 0
    ) {
      throw new Error(`release_evidence.manifest_identity_invalid:${path}`)
    }
    for (const log of manifest.logs ?? []) verifyDescription(root, log, 'log')
    if (manifest.kind === 'legacy-platform-build') {
      if (
        manifest.testManifest?.path !== canonicalTestPath ||
        manifest.testManifest?.sha256 !== canonicalTestHash ||
        !Array.isArray(manifest.artifacts) ||
        manifest.artifacts.length === 0
      ) {
        throw new Error(`release_evidence.build_manifest_incomplete:${path}`)
      }
      verifyDescription(root, manifest.testManifest, 'test_manifest')
      const smokeLog = manifest.logs.find((log) => basename(log.path).includes('smoke'))
      if (!smokeLog || !readFileSync(resolve(root, smokeLog.path), 'utf8').includes('"ok":true')) {
        throw new Error(`release_evidence.smoke_proof_invalid:${path}`)
      }
    }
    for (const artifact of manifest.artifacts ?? []) {
      if (
        typeof artifact.name !== 'string' ||
        basename(artifact.name) !== artifact.name ||
        !artifact.name.includes(PLATFORM_ARTIFACT_TOKEN[manifest.platform]) ||
        !Number.isInteger(artifact.bytes)
      ) {
        throw new Error(`release_evidence.artifact_description_invalid:${path}`)
      }
      const artifactPath = join(root, artifact.name)
      if (
        !existsSync(artifactPath) ||
        sha256File(artifactPath) !== artifact.sha256 ||
        statSync(artifactPath).size !== artifact.bytes
      ) {
        throw new Error(`release_evidence.artifact_hash_mismatch:${artifact.name}`)
      }
      verifiedArtifacts.push({ platform: manifest.platform, ...artifact })
    }
  }

  writeJson(reportPath, {
    schemaVersion: SCHEMA_VERSION,
    kind: 'legacy-release-report',
    releaseGeneration: 'legacy',
    status: 'passed',
    releaseCommit: commit,
    generatedAt: new Date().toISOString(),
    lockfile: { name: basename(lockfile), sha256: expectedLockfileHash },
    requiredPlatforms: REQUIRED_PLATFORMS,
    manifests: manifests.map(({ path, manifest }) => ({
      kind: manifest.kind,
      platform: manifest.platform,
      path: normalizedRelative(root, path),
      sha256: sha256File(path),
      toolchain: manifest.toolchain
    })),
    artifacts: verifiedArtifacts
  })
}

const [command, ...argv] = process.argv.slice(2)
if (command === 'create-test') createTest(argv)
else if (command === 'create-build') createBuild(argv)
else if (command === 'verify') verify(argv)
else throw new Error('usage: release-evidence <create-test|create-build|verify> [options]')
