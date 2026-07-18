import { type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import type { controlPlaneSchema } from './schema'

export type ControlPlaneDatabase = BetterSQLite3Database<typeof controlPlaneSchema>
export type AppTransaction = Parameters<Parameters<ControlPlaneDatabase['transaction']>[0]>[0]
export type DbExecutor = ControlPlaneDatabase | AppTransaction
