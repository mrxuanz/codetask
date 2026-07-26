import { join } from 'node:path'

/**
 * Central path resolver for the authentication-only application skeleton.
 * The legacy database path is read-only and exists solely for one-time account migration.
 */
export function dataPaths(dataDir: string): {
  authDbFile: string
  legacyDbFile: string
  sandboxHome: string
  sandboxRuntime: string
  conversationRuntime: string
  draftRuntime: string
  jobRuntime: string
  draftAssets: string
  jobIntakeAssets: string
} {
  return {
    authDbFile: join(dataDir, 'db', 'auth.db'),
    legacyDbFile: join(dataDir, 'db', 'app.db'),
    sandboxHome: join(dataDir, 'sandbox-home'),
    sandboxRuntime: join(dataDir, 'sandbox-runtime'),
    conversationRuntime: join(dataDir, 'sandbox-runtime', 'conversations'),
    draftRuntime: join(dataDir, 'sandbox-runtime', 'drafts'),
    jobRuntime: join(dataDir, 'sandbox-runtime', 'jobs'),
    draftAssets: join(dataDir, 'draft-assets'),
    jobIntakeAssets: join(dataDir, 'job-intake-assets')
  }
}
