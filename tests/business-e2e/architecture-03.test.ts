/**
 * Business E2E API surface after architecture 03.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { toCanonicalProviderCode, toHostCoreCode } from './api/operations.ts'
import { PART_DEFAULT_CASES } from './cases/selection.ts'
import { HONO_BUSINESS_ROUTES } from '../helpers/hono-business-routes.ts'

describe('business-e2e architecture 03 cutover', () => {
  it('maps host CLI codes to canonical conversation providers', () => {
    assert.equal(toCanonicalProviderCode('claude'), 'claude')
    assert.equal(toCanonicalProviderCode('cursor'), 'cursor')
    assert.equal(toHostCoreCode('claude'), 'claude')
    assert.equal(toHostCoreCode('cursor'), 'cursor')
  })

  it('operations chat path uses /api/conversations, not /api/threads', () => {
    const path = fileURLToPath(new URL('./api/operations.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    assert.equal(
      HONO_BUSINESS_ROUTES.projectConversations('project-1'),
      '/api/projects/project-1/conversations'
    )
    assert.equal(
      HONO_BUSINESS_ROUTES.conversationTurns('chat-1'),
      '/api/conversations/chat-1/turns'
    )
    assert.equal(
      HONO_BUSINESS_ROUTES.conversationAttachments('chat-1'),
      '/api/conversations/chat-1/attachments'
    )
    assert.match(source, /HONO_BUSINESS_ROUTES\.projectConversations/)
    assert.match(source, /HONO_BUSINESS_ROUTES\.conversationTurns/)
    assert.match(source, /HONO_BUSINESS_ROUTES\.conversationAttachments/)
    assert.doesNotMatch(source, /\/api\/projects\/\$\{projectId\}\/threads/)
    assert.match(source, /architecture_03_removed/)
  })

  it('OpenCode driver has no retired create_task case stubs', () => {
    const path = fileURLToPath(new URL('./drivers/opencode.ts', import.meta.url))
    const promptPath = fileURLToPath(new URL('./drivers/operator-prompt.ts', import.meta.url))
    const source = `${readFileSync(path, 'utf8')}\n${readFileSync(promptPath, 'utf8')}`
    assert.doesNotMatch(source, /codetask_confirm_draft_final/)
    assert.match(source, /design-draft-confirm/)
  })

  it('default design suite names the behavior it actually covers', () => {
    assert.deepEqual(PART_DEFAULT_CASES.design, ['design-draft-confirm'])
    assert.ok(PART_DEFAULT_CASES.conversation.includes('chat-basic'))
    assert.ok(!PART_DEFAULT_CASES.conversation.includes('design-draft-confirm'))
  })

  it('Test MCP exposes Design draft tools and deletes retired create_task helpers', () => {
    const path = fileURLToPath(new URL('./mcp/tools.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    assert.match(source, /name: 'codetask_create_draft'/)
    assert.match(source, /name: 'codetask_confirm_design_draft'/)
    assert.doesNotMatch(source, /name: 'codetask_confirm_draft'/)
    assert.doesNotMatch(source, /name: 'codetask_confirm_draft_final'/)
    assert.doesNotMatch(source, /name: 'codetask_get_plans'/)
    assert.doesNotMatch(source, /name: 'codetask_create_job'/)
    assert.doesNotMatch(source, /createTaskMode:\s*\{\s*type:\s*'boolean'/)
  })
})
