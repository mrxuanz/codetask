import { dirname, resolve } from 'path'

export type DataDirSource = 'config' | 'candidate' | 'cli'

export interface DataDirResolution {
  phase: 'ready' | 'selection_required'
  dataDir: string
  source: DataDirSource
  issue?: string
}

/** `dbPath` is `{dataDir}/db/app.db`; recover the selected data directory. */
export function dataDirFromDbPath(dbPath: string): string {
  return dirname(dirname(resolve(dbPath)))
}
