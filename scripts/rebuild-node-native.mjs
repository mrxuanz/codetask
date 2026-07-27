import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const nodeGyp = join(root, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
const moduleRoot = join(root, 'node_modules', 'better-sqlite3')
const nodeRoot = dirname(dirname(process.execPath))
const stagingRoot = join(root, '.cache', 'node-native-staging', 'better-sqlite3')
const stagingParent = dirname(stagingRoot)
const stagedBuild = join(stagingRoot, 'build', 'Release', 'better_sqlite3.node')
const installedBuild = join(moduleRoot, 'build', 'Release', 'better_sqlite3.node')

rmSync(stagingRoot, { recursive: true, force: true })
mkdirSync(stagingParent, { recursive: true })
cpSync(moduleRoot, stagingRoot, {
  recursive: true,
  filter(source) {
    return source !== join(moduleRoot, 'build')
  }
})

const result = spawnSync(
  process.execPath,
  [nodeGyp, 'rebuild', '--release', `--arch=${process.arch}`, `--nodedir=${nodeRoot}`],
  {
    cwd: stagingRoot,
    stdio: 'inherit'
  }
)

if ((result.status ?? 1) !== 0) {
  rmSync(stagingRoot, { recursive: true, force: true })
  console.error('[native] Node rebuild failed; the installed native binary was preserved.')
  process.exit(result.status ?? 1)
}
if (!existsSync(stagedBuild)) {
  rmSync(stagingRoot, { recursive: true, force: true })
  console.error(`[native] Node rebuild produced no binary at ${stagedBuild}`)
  process.exit(1)
}

mkdirSync(dirname(installedBuild), { recursive: true })
copyFileSync(stagedBuild, installedBuild)
rmSync(stagingRoot, { recursive: true, force: true })
console.log(`[native] installed better-sqlite3 for Node ${process.versions.node}`)
