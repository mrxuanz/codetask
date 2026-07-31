import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { closeIsolatedTestDatabase, createIsolatedTestDatabase } from '../server/db'

export function initializeStorageRoot(input: { dataDir: string }): {
  dataDir: string
  dbPath: string
} {
  const target = resolve(input.dataDir)
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error('Storage target must be empty')
  }

  const id = randomUUID()
  const staging = join(dirname(target), `${basename(target)}.codetask-init-${id}`)
  const emptyBackup = `${target}.codetask-empty-${id}`
  rmSync(staging, { recursive: true, force: true })

  let movedEmptyTarget = false
  try {
    mkdirSync(staging, { recursive: false, mode: 0o700 })
    mkdirSync(join(staging, 'assets'), { recursive: true })
    const db = createIsolatedTestDatabase(staging)
    closeIsolatedTestDatabase(db)

    if (existsSync(target)) {
      renameSync(target, emptyBackup)
      movedEmptyTarget = true
    }
    renameSync(staging, target)
    if (movedEmptyTarget) rmSync(emptyBackup, { recursive: true, force: true })
    return { dataDir: target, dbPath: join(target, 'db', 'app.db') }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (movedEmptyTarget && !existsSync(target) && existsSync(emptyBackup)) {
      renameSync(emptyBackup, target)
    }
    throw error
  }
}
