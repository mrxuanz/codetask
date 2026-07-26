import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { SystemClock } from '../adapters/clock/system-clock'
import { UuidIdGenerator } from '../adapters/ids/uuid-id-generator'
import {
  FakeExecutionRuntime,
  FakeProvider,
  InMemoryArtifactStore,
  InMemoryAttemptRepo,
  InMemoryDraftRepo,
  InMemoryIdempotencyStore,
  InMemoryJobRepo,
  InMemoryPlanRepo,
  InMemoryProviderRegistry,
  InMemoryRetentionStore,
  InMemoryTaskProjectionRepo,
  InMemoryThreadRepo,
  InMemoryUnitOfWork,
  InMemoryVerificationAttemptRepo,
  InMemoryWorkspaceLeaseRepo,
  RecordingEventPublisher
} from '../adapters/memory/index.ts'
import { asProviderRegistryPort } from '../adapters/providers/index.ts'
import {
  installProtectedRuntime,
  RuntimeAdapter,
  type LoadedNativeBinding
} from '../adapters/runtime/index.ts'
import {
  applyCoreSchema,
  createSqliteUnitOfWork,
  SqliteArtifactStore,
  SqliteDomainAttemptRepository,
  SqliteDomainDraftRepository,
  SqliteDomainJobRepository,
  SqliteDomainPlanRepository,
  SqliteDomainRetentionStore,
  SqliteDomainTaskProjectionRepository,
  SqliteDomainThreadRepository,
  SqliteDomainVerificationAttemptRepository,
  SqliteDomainWorkspaceLeaseRepository,
  SqliteIdempotencyStore,
  type SqliteDatabase
} from '../adapters/sqlite/index.ts'
import { BuiltinSkillCatalog } from '../core/application/skills/catalog'
import type { SafeLogger } from '../core/application/ports/safe-logger'
import { createProviderRegistry } from './create-provider-registry'
import { ensureCoreMigrated } from './ensure-core-migrated'
import type { ApplicationHandle, CreateApplicationOptions } from './types'

/** CI/sqlite composition: dry-run RuntimeAdapter must not require a real .node. */
const SQLITE_DRY_RUN_NATIVE: LoadedNativeBinding = {
  addonDir: '/virtual',
  nodePath: '/virtual/codeteam-sandbox.node',
  sha256: 'dry-run',
  modulesAbi: process.versions.modules,
  binding: {
    preflight() {},
    launchSandboxedWorker() {
      return {}
    }
  }
}

export type { ApplicationHandle, CreateApplicationOptions } from './types'

const consoleSafeLogger: SafeLogger = {
  info(message, fields) {
    if (fields === undefined) {
      console.log(message)
      return
    }
    console.log(message, fields)
  },
  warn(message, fields) {
    if (fields === undefined) {
      console.warn(message)
      return
    }
    console.warn(message, fields)
  },
  error(message, fields) {
    if (fields === undefined) {
      console.error(message)
      return
    }
    console.error(message, fields)
  }
}

function createMemoryApplication(): ApplicationHandle {
  const events = new RecordingEventPublisher()
  const unitOfWork = new InMemoryUnitOfWork(events)
  const providers = new InMemoryProviderRegistry()
  const fakeProvider = new FakeProvider('fake')
  providers.register(fakeProvider)

  return {
    kind: 'memory',
    unitOfWork,
    providers,
    runtime: new FakeExecutionRuntime(),
    skills: new BuiltinSkillCatalog(),
    artifacts: new InMemoryArtifactStore(),
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    events,
    logger: consoleSafeLogger,
    threads: new InMemoryThreadRepo(),
    drafts: new InMemoryDraftRepo(),
    plans: new InMemoryPlanRepo(),
    jobs: new InMemoryJobRepo(),
    idempotency: new InMemoryIdempotencyStore(),
    tasks: new InMemoryTaskProjectionRepo(),
    attempts: new InMemoryAttemptRepo(),
    leases: new InMemoryWorkspaceLeaseRepo(),
    verifications: new InMemoryVerificationAttemptRepo(),
    retention: new InMemoryRetentionStore(),
    close() {
      // memory mode — nothing to close
    }
  }
}

function createSqliteApplication(
  sqlitePath: string,
  options?: { readonly dryRun?: boolean }
): ApplicationHandle {
  const db: SqliteDatabase = new Database(sqlitePath)
  applyCoreSchema(db)

  const events = new RecordingEventPublisher()
  const unitOfWork = createSqliteUnitOfWork(db, events)
  const providers = asProviderRegistryPort(createProviderRegistry())

  const artifactsDir = join(dirname(sqlitePath), 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  const runtimeRoot = dirname(sqlitePath)

  // Tests/CI default dryRun:true + stub native. Production
  // (createApplicationForDataDir) uses dryRun:false and loads real .node.
  const dryRun = options?.dryRun !== false
  const runtime = new RuntimeAdapter({
    dryRun,
    ...(dryRun ? { native: SQLITE_DRY_RUN_NATIVE } : {}),
    workspace: {
      cwd: runtimeRoot,
      runtimeRoot
    },
    providerProfile: { providerCode: 'fake' }
  })
  installProtectedRuntime(runtime)

  // Domain repos with core_* sqlite backing. Providers use Wave 7C adapters
  // (Fake live; others stubMode:true).
  return {
    kind: 'sqlite',
    unitOfWork,
    providers,
    runtime,
    skills: new BuiltinSkillCatalog(),
    artifacts: new SqliteArtifactStore(db, artifactsDir),
    clock: new SystemClock(),
    ids: new UuidIdGenerator(),
    events,
    logger: consoleSafeLogger,
    threads: new SqliteDomainThreadRepository(db),
    drafts: new SqliteDomainDraftRepository(db),
    plans: new SqliteDomainPlanRepository(db),
    jobs: new SqliteDomainJobRepository(db),
    idempotency: new SqliteIdempotencyStore(db),
    tasks: new SqliteDomainTaskProjectionRepository(db),
    attempts: new SqliteDomainAttemptRepository(db),
    leases: new SqliteDomainWorkspaceLeaseRepository(db),
    verifications: new SqliteDomainVerificationAttemptRepository(db),
    retention: new SqliteDomainRetentionStore(db),
    close() {
      db.close()
    }
  }
}

/**
 * Composition root for the new core kernel.
 * Adapters are imported only here (composition layer).
 *
 * Memory mode is for tests only — pass `{ mode: 'memory' }` explicitly.
 * Production boots via {@link createApplicationForDataDir} (sqlite under dataDir).
 */
export function createApplication(options?: CreateApplicationOptions): ApplicationHandle {
  const mode = options?.mode ?? 'memory'
  if (mode === 'sqlite') {
    const sqlitePath = options?.sqlitePath
    if (!sqlitePath) {
      throw new Error('createApplication({ mode: "sqlite" }) requires sqlitePath')
    }
    // Test/CI sqlite composition stays dry-run.
    return createSqliteApplication(sqlitePath, { dryRun: true })
  }
  // Memory mode leaves protected runtime uninstalled (tests use FakeExecutionRuntime).
  return createMemoryApplication()
}

/** Production path: sqlite at `<dataDir>/core/kernel.sqlite`. */
export function createApplicationForDataDir(dataDir: string): ApplicationHandle {
  const sqlitePath = join(dataDir, 'core', 'kernel.sqlite')
  mkdirSync(dirname(sqlitePath), { recursive: true })
  ensureCoreMigrated({
    dataDir,
    coreSqlitePath: sqlitePath,
    logger: consoleSafeLogger
  })
  // Live RuntimeAdapter gateway (dryRun:false); installProtectedRuntime inside.
  return createSqliteApplication(sqlitePath, { dryRun: false })
}
