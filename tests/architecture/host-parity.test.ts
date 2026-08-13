import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHonoApp } from '@codetask/server-core'
import { Hono } from 'hono'

const root = join(import.meta.dirname, '../..')

/**
 * Shared HTTP capability surface for desktop + standalone/service hosts.
 * Both hosts call createApp → createApiRoutes; this list is the parity contract.
 */
export const SHARED_API_CAPABILITY_PREFIXES = [
  '/auth',
  '/conversations',
  '/drafts',
  '/execution-queue',
  '/fs',
  '/health',
  '/jobs',
  '/mcp',
  '/planning-sessions',
  '/projects',
  '/realtime',
  '/settings',
  '/system'
].sort()

function assertSourceMentionsPrefix(source: string, prefix: string): void {
  const bare = prefix.slice(1)
  const ok =
    source.includes(`'${prefix}'`) ||
    source.includes(`"${prefix}"`) ||
    source.includes(`'/${bare}`) ||
    source.includes(`"/${bare}`) ||
    (bare === 'drafts' && /design\.routes|\/drafts/.test(source)) ||
    (bare === 'planning-sessions' && /design\.routes|\/planning-sessions/.test(source)) ||
    (bare === 'conversations' && /conv\.routes|\/conversations/.test(source)) ||
    (bare === 'jobs' && /exec\.routes|\/jobs/.test(source)) ||
    (bare === 'execution-queue' && /exec\.routes|\/execution-queue/.test(source))
  assert.ok(ok, `createApiRoutes must mount capability ${prefix}`)
}

describe('host parity (01)', () => {
  it('createHonoApp mounts a single /api surface for desktop and service hosts', async () => {
    const api = new Hono()
    api.get('/health', (c) => c.json({ success: true, data: { status: 'ok' } }))
    const app = createHonoApp({
      isDev: true,
      rendererDevUrl: 'http://127.0.0.1:5173',
      api
    })
    const res = await app.request('http://127.0.0.1/api/health')
    assert.equal(res.status, 200)
    const body = (await res.json()) as { data?: { status?: string } }
    assert.equal(body.data?.status, 'ok')
  })

  it('desktop package is the thin Electron host and the Service owns Hono startup', () => {
    const desktopPkg = readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')
    const service = readFileSync(join(root, 'apps/service/src/main.ts'), 'utf8')
    const mainIndex = readFileSync(join(root, 'apps/desktop/src/index.ts'), 'utf8')
    const appMain = readFileSync(join(root, 'apps/desktop/src/app-main.ts'), 'utf8')
    const desktopService = readFileSync(join(root, 'apps/desktop/src/desktop-service.ts'), 'utf8')
    const server = readFileSync(join(root, 'apps/service/src/server.ts'), 'utf8')

    assert.match(desktopPkg, /@codetask\/desktop/)
    assert.doesNotMatch(desktopPkg, /@codetask\/server-core/)
    assert.match(desktopPkg, /@codetask\/service-bootstrap/)
    assert.match(mainIndex, /app-main/)
    assert.match(appMain, /startDesktopService/)
    assert.doesNotMatch(appMain, /startAppServer/)
    assert.doesNotMatch(appMain, /ipcMain|get-server-info/)
    assert.match(desktopService, /spawnSupervisedService/)
    assert.match(desktopService, /resolveHostNodeBinary/)
    assert.match(desktopService, /CODETASK_HOST_NODE/)
    assert.match(desktopService, /ELECTRON_RUN_AS_NODE/)
    assert.match(service, /startAppServer/)
    assert.match(service, /@codetask\/agent-runtime\/host-environment/)
    assert.doesNotMatch(service, /src\/server\/host-environment/)
    assert.match(server, /\bcreateApp\b/)
  })

  it('desktop package contains runtime artifacts rather than repository sources', () => {
    const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')

    assert.match(builder, /- out\/main\/\*\*/)
    assert.match(builder, /- out\/renderer\/\*\*/)
    assert.doesNotMatch(builder, /- out\/preload/)
    assert.match(builder, /- native\/codeteam-sandbox\/\*\.node/)
    assert.doesNotMatch(builder, /^\s*- \*\*\/\*\s*$/m)
    assert.doesNotMatch(builder, /^\s*- (?:apps|docs|packages|scripts|src|tests)\//m)
  })

  it('createApiRoutes exposes a stable shared capability manifest', () => {
    const source = readFileSync(join(root, 'src/server/routes/api.ts'), 'utf8')
    const sorted = [...SHARED_API_CAPABILITY_PREFIXES].sort()
    assert.deepEqual(SHARED_API_CAPABILITY_PREFIXES, sorted)

    for (const prefix of SHARED_API_CAPABILITY_PREFIXES) {
      assertSourceMentionsPrefix(source, prefix)
    }
  })
})
