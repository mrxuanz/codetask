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
} {
  return {
    authDbFile: join(dataDir, 'db', 'auth.db'),
    legacyDbFile: join(dataDir, 'db', 'app.db'),
    sandboxHome: join(dataDir, 'sandbox-home'),
    sandboxRuntime: join(dataDir, 'sandbox-runtime')
  }
}
