export * from './schema/design.ts'
export * from './schema/execution.ts'
export * from './schema/registry.ts'
export { designSchemaMigrations } from './migrations/index.ts'
export {
  executionSchemaMigrations,
  migration045ExecutionModuleTables
} from './migrations/execution.ts'
export {
  MIGRATION_MANIFEST,
  migrationChecksum,
  listManifestMigrations,
  assertManifestContiguous,
  findManifestEntry
} from './migrations/manifest.ts'
export { migration062AssetsAndDropDeadRuntimeTables } from './migrations/assets-and-drop-dead-runtime.ts'
export { migration063ProjectFkAndAssetStorageKeys } from './migrations/project-fk-and-asset-storage.ts'
export {
  migration064DropBackupAndMarkerTables,
  BATCH_I_ABSENT_TABLES,
  BATCH_I_DEFERRED_LEGACY_TABLES
} from './migrations/drop-backup-and-marker-tables.ts'
export { migration065DropLegacyThreadTables } from './migrations/drop-legacy-thread-tables.ts'

export { allMigrations, applyMigrations, runMigrations } from './migrations/all.ts'
export {
  assertMigrationsAlignWithManifest,
  ensureMigrationsTable,
  currentMigrationVersion
} from './migrations/runner.ts'
export type { Migration } from './migrations/all.ts'
export * from './schema/host.ts'
