/**
 * Business E2E API surface after architecture 03.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { toCanonicalProviderCode, toHostCoreCode } from './api/operations.ts'
import { PART_DEFAULT_CASES } from './cases/selection.ts'

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
    assert.match(source, /\/api\/projects\/\$\{projectId\}\/conversations/)
    assert.match(source, /\/api\/conversations\/\$\{threadId\}\/turns/)
    assert.match(source, /\/api\/conversations\/\$\{threadId\}\/attachments/)
    assert.doesNotMatch(source, /\/api\/projects\/\$\{projectId\}\/threads/)
    assert.match(source, /architecture_03_removed/)
  })

  it('OpenCode driver has no create_task draft-job case stubs', () => {
    const path = fileURLToPath(new URL('./drivers/opencode.ts', import.meta.url))
    const source = readFileSync(path, 'utf8')
    assert.doesNotMatch(source, /DRAFT-CHAT-IMG-001/)
    assert.doesNotMatch(source, /codetask_confirm_draft_final/)
    assert.match(source, /DESIGN-DRAFT-001/)
  })

  it('default draft-job suite includes Design draft smoke', () => {
    assert.deepEqual(PART_DEFAULT_CASES['draft-job'], ['DESIGN-DRAFT-001'])
    assert.ok(PART_DEFAULT_CASES.conversation.includes('G3-001'))
    assert.ok(!PART_DEFAULT_CASES.conversation.includes('DRAFT-CHAT-IMG-001'))
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
