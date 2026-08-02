import type Database from 'better-sqlite3'
import {
  AuthApplication,
  type CredentialsPolicy
} from './application/auth-application.ts'
import { createAuthHttpRoutes, type AuthHttpDeps } from './http/auth-routes.ts'
import { HmacTokenDigester, ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher.ts'
import { SqliteAuthRepository } from './infrastructure/sqlite-auth-repository.ts'

export type AuthModule = {
  app: AuthApplication
  /** Routes relative to `/auth` mount point. */
  createRoutes: (http: Omit<AuthHttpDeps, 'auth' | 'authSecret'>) => ReturnType<typeof createAuthHttpRoutes>
  cleanup: () => void
}

export type AuthModuleDeps = {
  db: Database.Database
  authSecret: string
  credentials: CredentialsPolicy
  clock?: () => number
}

export function composeAuthModule(deps: AuthModuleDeps): AuthModule {
  const store = new SqliteAuthRepository(deps.db)
  const passwords = new ScryptPasswordHasher()
  const digester = new HmacTokenDigester(deps.authSecret)
  const app = new AuthApplication(
    store,
    passwords,
    digester,
    deps.credentials,
    deps.clock ? { nowMs: deps.clock } : undefined
  )

  return {
    app,
    createRoutes(http) {
      return createAuthHttpRoutes({
        ...http,
        auth: app,
        authSecret: deps.authSecret
      })
    },
    cleanup() {
      app.cleanup()
    }
  }
}
