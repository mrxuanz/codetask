#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const outMain = join(root, 'out', 'main')
const outRenderer = join(root, 'out', 'renderer')
const nccCli = join(root, 'node_modules', '@vercel', 'ncc', 'dist', 'ncc', 'cli.js')
const postjectCli = join(root, 'node_modules', 'postject', 'dist', 'cli.js')
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const WORKER_NAMES = ['role-worker.js', 'role-worker-cursor-job.js', 'supervisor-entry.js']

function readArg(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
    ...options
  })
  if (result.error) throw result.error
  if ((result.status ?? 1) !== 0) {
    throw new Error(`server_sea.command_failed:${command}:${result.status ?? 'unknown'}`)
  }
}

function requireFile(path, label) {
  if (!existsSync(path)) throw new Error(`server_sea.${label}_missing:${path}`)
}

function runtimePlatform() {
  if (process.platform === 'linux' && process.arch === 'x64') return 'linux-x64'
  if (process.platform === 'linux' && process.arch === 'arm64') return 'linux-arm64'
  if (process.platform === 'darwin' && process.arch === 'x64') return 'macos-x64'
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'macos-arm64'
  if (process.platform === 'win32' && process.arch === 'x64') return 'windows-x64'
  if (process.platform === 'win32' && process.arch === 'arm64') return 'windows-arm64'
  throw new Error(`server_sea.unsupported_runtime:${process.platform}-${process.arch}`)
}

function copyNativeRuntime(destination) {
  const source = join(root, 'native', 'codeteam-sandbox')
  const target = join(destination, 'native', 'codeteam-sandbox')
  mkdirSync(target, { recursive: true })
  for (const filename of ['index.js', 'setup-entry.js', 'runner-entry.js']) {
    requireFile(join(source, filename), `native_${filename}`)
    copyFileSync(join(source, filename), join(target, filename))
  }
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.node')) {
      copyFileSync(join(source, entry.name), join(target, entry.name))
    }
  }
  const helpers = join(source, 'helpers')
  if (existsSync(helpers)) cpSync(helpers, join(target, 'helpers'), { recursive: true })
}

function writeSeaEntry(nccEntry, output) {
  const original = readFileSync(nccEntry, 'utf8')
  const nativeRequire = 'require(__nccwpck_require__.ab + "build/Release/better_sqlite3.node")'
  const nativeRequireReplacement =
    '__seaCreateRequire(__filename)(__nccwpck_require__.ab + "build/Release/better_sqlite3.node")'
  if (!original.includes(nativeRequire)) {
    throw new Error('server_sea.ncc_native_require_contract_missing')
  }
  const bundled = original.replace(nativeRequire, nativeRequireReplacement)
  const bootstrap = `'use strict';\nconst { existsSync: __seaExistsSync } = require('node:fs');\nconst { createRequire: __seaCreateRequire } = require('node:module');\nconst { basename: __seaBasename, dirname: __seaDirname, join: __seaJoin, resolve: __seaResolve } = require('node:path');\nconst __seaPackageRoot = __seaDirname(__seaDirname(process.execPath));\nprocess.env.CODETASK_STATIC_DIR ||= __seaJoin(__seaPackageRoot, 'renderer');\nprocess.env.CODETASK_APP_ROOT ||= __seaPackageRoot;\nprocess.env.CODETEAM_SANDBOX_NATIVE ||= __seaJoin(__seaPackageRoot, 'native', 'codeteam-sandbox');\nconst __seaScriptIndex = process.argv.findIndex((value, index) => index > 0 && /\\.[cm]?js$/u.test(value));\nif (__seaScriptIndex > 1) process.argv.splice(1, __seaScriptIndex - 1);\nconst __seaScriptArg = __seaScriptIndex > 0 && process.argv[1] ? __seaResolve(process.argv[1]) : null;\nif (__seaScriptArg && __seaExistsSync(__seaScriptArg)) {\n  const __seaName = __seaBasename(__seaScriptArg);\n  const __seaWorkerNames = new Set(${JSON.stringify(WORKER_NAMES)});\n  const __seaTarget = __seaWorkerNames.has(__seaName)\n    ? __seaJoin(__seaPackageRoot, 'sandbox', 'worker-runtime.cjs')\n    : __seaScriptArg;\n  __seaCreateRequire(__seaTarget)(__seaTarget);\n} else {\n`
  writeFileSync(output, `${bootstrap}${bundled}\n}\n`)
}

const platform = readArg('--platform', runtimePlatform())
const version = readArg(
  '--version',
  process.env.CODETASK_RELEASE_VERSION?.trim() ||
    JSON.parse(readFileSync(join(root, 'package.json'))).version
)
if (platform !== runtimePlatform()) {
  throw new Error(`server_sea.platform_mismatch:${platform}:${runtimePlatform()}`)
}
if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(version)) {
  throw new Error(`server_sea.invalid_version:${version}`)
}

requireFile(join(outMain, 'standalone.js'), 'standalone_entry')
requireFile(outRenderer, 'renderer')
requireFile(nccCli, 'ncc')
requireFile(postjectCli, 'postject')

const packageName = `codetask-server-${version}-${platform}`
const packageDir = join(dist, packageName)
const staging = join(dist, '.server-sea-staging', platform)
const mainNcc = join(staging, 'main-ncc')
const workerNcc = join(staging, 'worker-ncc')
const binDir = join(packageDir, 'bin')
const sandboxDir = join(packageDir, 'sandbox')
const executableName = process.platform === 'win32' ? 'codetask-server.exe' : 'codetask-server'
const executable = join(binDir, executableName)

rmSync(staging, { recursive: true, force: true })
rmSync(packageDir, { recursive: true, force: true })
mkdirSync(mainNcc, { recursive: true })
mkdirSync(workerNcc, { recursive: true })
mkdirSync(binDir, { recursive: true })
mkdirSync(sandboxDir, { recursive: true })

run(process.execPath, [
  nccCli,
  'build',
  join(outMain, 'standalone.js'),
  '-o',
  mainNcc,
  '--no-cache',
  '--no-source-map-register'
])

const workerRouter = join(staging, 'worker-router.cjs')
writeFileSync(
  workerRouter,
  `'use strict'\nconst name = require('node:path').basename(process.argv[1] || '')\nswitch (name) {\n${WORKER_NAMES.map((name) => `  case ${JSON.stringify(name)}: require(${JSON.stringify(join(outMain, 'sandbox', name))}); break`).join('\n')}\n  default: throw new Error('server_sea.unknown_worker:' + name)\n}\n`
)
run(process.execPath, [
  nccCli,
  'build',
  workerRouter,
  '-o',
  workerNcc,
  '--no-cache',
  '--no-source-map-register'
])

for (const entry of readdirSync(mainNcc, { withFileTypes: true })) {
  if (entry.name === 'index.js' || entry.name === 'sandbox') continue
  cpSync(join(mainNcc, entry.name), join(binDir, entry.name), { recursive: true })
}
for (const entry of readdirSync(workerNcc, { withFileTypes: true })) {
  if (entry.name === 'sandbox') continue
  const destination = ['index.js', 'index.cjs'].includes(entry.name)
    ? 'worker-runtime.cjs'
    : entry.name
  cpSync(join(workerNcc, entry.name), join(sandboxDir, destination), { recursive: true })
}
for (const name of WORKER_NAMES) writeFileSync(join(sandboxDir, name), `'use strict'\n`)

cpSync(outRenderer, join(packageDir, 'renderer'), { recursive: true })
copyNativeRuntime(packageDir)

const seaEntry = join(staging, 'sea-entry.cjs')
const seaBlob = join(staging, 'sea-prep.blob')
const seaConfig = join(staging, 'sea-config.json')
writeSeaEntry(join(mainNcc, 'index.js'), seaEntry)
writeFileSync(
  seaConfig,
  `${JSON.stringify(
    {
      main: seaEntry,
      output: seaBlob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false
    },
    null,
    2
  )}\n`
)
run(process.execPath, ['--experimental-sea-config', seaConfig])
copyFileSync(process.execPath, executable)

if (process.platform === 'darwin') run('codesign', ['--remove-signature', executable])
const postjectArgs = [
  postjectCli,
  executable,
  'NODE_SEA_BLOB',
  seaBlob,
  '--sentinel-fuse',
  SEA_FUSE
]
if (process.platform === 'darwin') postjectArgs.push('--macho-segment-name', 'NODE_SEA')
run(process.execPath, postjectArgs)
if (process.platform === 'darwin') run('codesign', ['--sign', '-', executable])
if (process.platform !== 'win32') chmodSync(executable, 0o755)

writeFileSync(
  join(packageDir, 'manifest.json'),
  `${JSON.stringify(
    {
      name: 'codetask-server',
      version,
      platform,
      node: process.version,
      ncc: JSON.parse(readFileSync(join(root, 'node_modules', '@vercel', 'ncc', 'package.json')))
        .version,
      executable: `bin/${executableName}`,
      start: process.platform === 'win32' ? `.\\bin\\${executableName}` : `./bin/${executableName}`
    },
    null,
    2
  )}\n`
)

const archive = join(dist, `${packageName}.tar.gz`)
rmSync(archive, { force: true })
run('tar', ['-czf', archive, '-C', dist, packageName])
if (!existsSync(archive) || statSync(archive).size === 0) {
  throw new Error(`server_sea.archive_missing:${archive}`)
}
writeFileSync(
  join(dist, `server-sea-${platform}.json`),
  `${JSON.stringify({ platform, packageDir, executable, archive }, null, 2)}\n`
)
console.log(JSON.stringify({ ok: true, platform, executable, archive }))
