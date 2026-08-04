/**
 * Batch H architecture gates — contracts ownership + apps/web client tree (R1).
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const root = join(import.meta.dirname, '../..')

function walk(dir: string, files: string[] = []): string[] {
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out') continue
    const full = join(dir, name)
    const st = statSync(full)
    if (st.isDirectory()) walk(full, files)
    else if (/\.(ts|tsx|vue)$/.test(name)) files.push(full)
  }
  return files
}

function rel(file: string): string {
  return relative(root, file).split('\\').join('/')
}

describe('architecture gates — Batch H', () => {
  it('apps/web production sources do not import @shared/contracts', () => {
    const offenders: string[] = []
    for (const file of walk(join(root, 'apps/web/src'))) {
      if (/@shared\/contracts/.test(readFileSync(file, 'utf8'))) {
        offenders.push(rel(file))
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })

  it('packages/contracts exposes client + UI bridge modules + retention', () => {
    for (const file of [
      'packages/contracts/src/client-api.ts',
      'packages/contracts/src/ui-conversation.ts',
      'packages/contracts/src/ui-thread.ts',
      'packages/contracts/src/ui-jobs.ts',
      'packages/contracts/src/ui-planning.ts',
      'packages/contracts/src/ui-draft.ts',
      'packages/contracts/src/job-reference.ts',
      'packages/contracts/src/retention.ts',
      'packages/contracts/src/api.ts'
    ]) {
      assert.equal(existsSync(join(root, file)), true, file)
    }
    const index = readFileSync(join(root, 'packages/contracts/src/index.ts'), 'utf8')
    assert.match(index, /client-api/)
    assert.match(index, /ui-conversation/)
    assert.match(index, /ui-planning/)
    assert.match(index, /retention/)
  })

  it('threads façade is deleted; conversation client owns list helpers', () => {
    assert.equal(existsSync(join(root, 'apps/web/src/api/threads.ts')), false)
    const conversation = readFileSync(join(root, 'apps/web/src/api/conversation.ts'), 'utf8')
    assert.doesNotMatch(conversation, /toHostCore/)
    assert.match(conversation, /conversationToListItem/)
    assert.match(conversation, /providerCode/)
  })

  it('jobs façade does not invent empty threadId for draft list items', () => {
    const jobs = readFileSync(join(root, 'apps/web/src/api/jobs.ts'), 'utf8')
    assert.doesNotMatch(jobs, /threadId:\s*''/)
    assert.match(jobs, /uploadConversationAttachment/)
    assert.match(jobs, /job\.state/)
  })

  it('UI production sources do not assign coreCode fields', () => {
    const offenders: string[] = []
    for (const file of walk(join(root, 'apps/web/src'))) {
      if (file.endsWith('/api/design.ts')) continue // maps providerCode → wire coreCode
      const source = readFileSync(file, 'utf8')
      // Allow recommendedCoreCode (Design draft ability wire field) and comments.
      const withoutWire = source.replace(/recommendedCoreCode/g, 'RECOMMENDED')
      if (/\bcoreCode\b/.test(withoutWire)) {
        offenders.push(rel(file))
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })

  it('src/server and apps/web have zero shared/contracts importers', () => {
    const offenders: string[] = []
    for (const base of ['src/server', 'apps/web/src']) {
      for (const file of walk(join(root, base))) {
        const source = readFileSync(file, 'utf8')
        if (/shared\/contracts|@shared\/contracts/.test(source)) {
          offenders.push(rel(file))
        }
      }
    }
    assert.deepEqual(offenders, [], offenders.join('\n'))
  })

  it('apps/web owns renderer source and Vite root', () => {
    assert.equal(existsSync(join(root, 'apps/web/index.html')), true)
    assert.equal(existsSync(join(root, 'apps/web/src/main.ts')), true)
    assert.equal(existsSync(join(root, 'src/renderer')), false)
    const vite = readFileSync(join(root, 'apps/web/vite.config.ts'), 'utf8')
    assert.match(vite, /@renderer/)
    assert.doesNotMatch(vite, /src\/renderer/)
    const electronVite = readFileSync(join(root, 'electron.vite.config.ts'), 'utf8')
    assert.match(electronVite, /input:\s*resolve\('apps\/web\/index\.html'\)/)
    assert.match(electronVite, /'@server':\s*resolve\('src\/server'\)/)
    assert.doesNotMatch(electronVite, /src\/renderer/)
  })

  it('server response helpers emit requestId (ApiSuccess/ApiFailure)', () => {
    const responseFiles = [
      'src/server/response.ts',
      'src/server/middleware/body-limiter.ts',
      'src/server/middleware/http-limits.ts',
      'src/server/middleware/request-guard.ts',
      'src/server/middleware/require-auth.ts',
      'packages/server-core/src/create-app.ts',
      'packages/server-core/src/modules/design/draft/http/routes.ts'
    ]
    for (const file of responseFiles) {
      const response = readFileSync(join(root, file), 'utf8')
      assert.match(response, /requestId/, `${file} must emit a requestId`)
      assert.match(response, /success:\s*(?:true|false)/, `${file} must use the API envelope`)
      assert.doesNotMatch(response, /extra:/, `${file} must not emit the legacy extra field`)
      assert.doesNotMatch(
        response,
        /status:\s*(?:0|40[013]01|41301)/,
        `${file} must not emit legacy application status codes`
      )
      assert.doesNotMatch(
        response,
        /message\s*=\s*'success'/,
        `${file} must not emit the legacy success message`
      )
    }
  })

  it('web client validates pure ApiSuccess/ApiFailure envelope', () => {
    const client = readFileSync(join(root, 'apps/web/src/api/client.ts'), 'utf8')
    assert.doesNotMatch(client, /extra:/)
    assert.doesNotMatch(client, /body\.status/)
    assert.doesNotMatch(client, /body\.message/)
    assert.match(client, /requestId/)
  })

  it('server retention imports come from @codetask/contracts', () => {
    const lifecycle = readFileSync(join(root, 'src/server/retention/lifecycle.ts'), 'utf8')
    assert.match(lifecycle, /@codetask\/contracts/)
    assert.doesNotMatch(lifecycle, /shared\/contracts\/retention/)
  })
})
