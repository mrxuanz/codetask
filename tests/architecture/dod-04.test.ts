/**
 * Architecture 04 DoD checklist — Auth module cutover.
 * @see docs/架构收口/04-登录与统一鉴权.md §20
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { isPublicApiRoute } from '../../src/server/middleware/require-auth.ts'

const root = join(import.meta.dirname, '../..')

function exists(rel: string): boolean {
  try {
    const st = statSync(join(root, rel))
    return st.isFile() || st.isDirectory()
  } catch {
    return false
  }
}

function walk(dir: string, files: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|vue)$/.test(name)) files.push(full)
  }
  return files
}

describe('architecture 04 DoD', () => {
  it('Auth module lives under packages/server-core/src/modules/auth', () => {
    assert.equal(exists('packages/server-core/src/modules/auth'), true)
    assert.equal(exists('packages/server-core/src/modules/auth/composition.ts'), true)
    assert.equal(
      exists('packages/server-core/src/modules/auth/application/auth-application.ts'),
      true
    )
    assert.equal(exists('packages/server-core/src/modules/auth/http/auth-routes.ts'), true)
  })

  it('contracts expose Auth Actor / bootstrap schemas', () => {
    const auth = readFileSync(join(root, 'packages/contracts/src/auth.ts'), 'utf8')
    assert.match(auth, /AuthBootstrapSchema|ActorSchema/)
    assert.match(auth, /auth\.unauthorized/)
  })

  it('public allowlist is /api/auth/* + health only (no root auth paths)', () => {
    assert.equal(isPublicApiRoute('GET', '/api/auth/bootstrap'), true)
    assert.equal(isPublicApiRoute('POST', '/api/auth/login'), true)
    assert.equal(isPublicApiRoute('POST', '/api/auth/setup'), true)
    assert.equal(isPublicApiRoute('POST', '/api/auth/captcha'), true)
    assert.equal(isPublicApiRoute('GET', '/api/health'), true)
    assert.equal(isPublicApiRoute('GET', '/api/bootstrap'), false)
    assert.equal(isPublicApiRoute('POST', '/api/login'), false)
    assert.equal(isPublicApiRoute('POST', '/api/setup'), false)
  })

  it('host does not define requireUsername', () => {
    const session = readFileSync(join(root, 'src/server/auth/session.ts'), 'utf8')
    assert.doesNotMatch(session, /requireUsername/)
    for (const file of walk(join(root, 'src/server/routes'))) {
      const source = readFileSync(file, 'utf8')
      assert.doesNotMatch(source, /requireUsername/)
    }
  })

  it('api mounts Auth under /auth and MCP outside session middleware', () => {
    const api = readFileSync(join(root, 'src/server/routes/api.ts'), 'utf8')
    assert.match(api, /route\('\/auth'/)
    assert.match(api, /route\('\/mcp'/)
    assert.match(api, /createMcpRoutes/)
    // MCP registered before secured stack
    const mcpIdx = api.indexOf("route('/mcp'")
    const securedIdx = api.indexOf('const secured')
    assert.ok(mcpIdx >= 0 && securedIdx >= 0 && mcpIdx < securedIdx)
  })

  it('Actor middleware uses principal.userId not username', () => {
    const api = readFileSync(join(root, 'src/server/routes/api.ts'), 'utf8')
    assert.doesNotMatch(api, /userId:\s*principal\.username/)
    assert.match(api, /toModuleActor|principalToActor/)
  })

  it('renderer does not write task_token; only clears legacy keys', () => {
    const token = readFileSync(join(root, 'apps/web/src/auth/token.ts'), 'utf8')
    assert.doesNotMatch(token, /localStorage\.setItem/)
    assert.match(token, /localStorage\.removeItem/)
    const authApi = readFileSync(join(root, 'apps/web/src/api/auth.ts'), 'utf8')
    assert.match(authApi, /\/api\/auth\//)
    assert.doesNotMatch(authApi, /\/api\/bootstrap|\/api\/login[^/]|\/api\/setup[^/]/)
  })

  it('src/server/auth has no duplicate SqliteAuthStore / SecureAuthService body', () => {
    assert.equal(exists('src/server/auth/store.ts'), false)
    assert.equal(exists('src/server/auth/timing-safe.ts'), false)
    assert.equal(exists('src/server/auth/password.ts'), false)
    const service = readFileSync(join(root, 'src/server/auth/service.ts'), 'utf8')
    assert.match(service, /composeAuthModule/)
    assert.doesNotMatch(service, /mapAuthThrown|createSecureAuthFromDb/)
  })

  it('migration 051/052 remap actor ownership and are registered', () => {
    assert.equal(exists('src/server/db/migrations/051_actor_id_username_to_user_id.ts'), true)
    assert.equal(exists('packages/database/src/migrations/auth-actor-remap.ts'), true)
    assert.equal(exists('src/server/db/migrations/052_projects_username_to_actor_id.ts'), true)
    assert.equal(exists('packages/database/src/migrations/projects-actor-id.ts'), true)
    assert.equal(exists('src/server/db/migrations/056_tighten_legacy_thread_schema.ts'), true)
    assert.equal(exists('packages/database/src/migrations/tighten-legacy-thread-schema.ts'), true)
    assert.equal(exists('src/server/db/migrations/057_legacy_owner_actor_id.ts'), true)
    assert.equal(exists('packages/database/src/migrations/legacy-owner-actor-id.ts'), true)
    const index = readFileSync(join(root, 'src/server/db/migrations/index.ts'), 'utf8')
    assert.match(index, /migration051ActorIdUsernameToUserId/)
    assert.match(index, /migration052ProjectsUsernameToActorId/)
    assert.match(index, /migration056TightenLegacyThreadSchemaTables/)
    assert.match(index, /migration057LegacyOwnerActorIdTables/)
    const schema = readFileSync(join(root, 'src/server/db/schema.ts'), 'utf8')
    assert.match(schema, /actorId: text\('actor_id'\)/)
    assert.doesNotMatch(schema, /export const threads =/)
    assert.doesNotMatch(schema, /export const threadMessages =/)
    assert.match(schema, /export const projects =/)
  })

  it('SSE routes bind session and recheck auth.session.expired', () => {
    const realtime = readFileSync(join(root, 'src/server/routes/realtime.ts'), 'utf8')
    assert.match(realtime, /auth\.session\.expired/)
    assert.match(realtime, /isSessionActive/)
    assert.match(realtime, /closeRealtimeForSession/)
    assert.equal(exists('src/server/events/realtime-session-registry.ts'), true)
    assert.equal(exists('tests/auth/realtime-session.test.ts'), true)
  })

  it('project routes own by Actor.userId not username', () => {
    const routes = readFileSync(join(root, 'src/server/routes/projects.ts'), 'utf8')
    assert.match(routes, /requireActorUserId\(\)/)
    assert.doesNotMatch(routes, /requireAuthPrincipal\(\)\.username/)
    assert.doesNotMatch(routes, /requireAuthPrincipal\(\)\.userId/)
  })

  it('host Auth routes compose via AuthModule.createRoutes', () => {
    const auth = readFileSync(join(root, 'src/server/routes/auth.ts'), 'utf8')
    assert.match(auth, /\.module\.createRoutes/)
    assert.doesNotMatch(auth, /createAuthHttpRoutes\(/)
  })
})
