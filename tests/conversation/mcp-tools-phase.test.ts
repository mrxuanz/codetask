import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { conversationMcpToolDefinitionsForPhase } from '../../src/server/conversation/mcp/tools'
import { toolsForWizardPhase } from '../../src/server/wizard/tools'
import { WIZARD_PHASE_COLLECT, WIZARD_PHASE_DRAFT_REVIEW } from '../../src/server/wizard/types'

function toolNames(defs: Record<string, unknown>[]): string[] {
  return defs.map((t) => t.name as string)
}

describe('MCP tool definitions per wizard phase', () => {
  it('collect phase exposes propose_task_draft but not draft review tools', () => {
    const defs = conversationMcpToolDefinitionsForPhase(WIZARD_PHASE_COLLECT)
    const names = toolNames(defs)

    assert.ok(names.includes('propose_task_draft'))
    assert.ok(!names.includes('get_task_draft'))
    assert.ok(!names.includes('update_task_draft'))
    assert.ok(!names.includes('confirm_requirements_contract'))
    assert.ok(!names.includes('request_phase_rollback'))
  })

  it('draft_review phase exposes get/update_task_draft but not propose_task_draft', () => {
    const defs = conversationMcpToolDefinitionsForPhase(WIZARD_PHASE_DRAFT_REVIEW)
    const names = toolNames(defs)

    assert.ok(names.includes('get_task_draft'))
    assert.ok(names.includes('update_task_draft'))
    assert.ok(!names.includes('propose_task_draft'))
  })

  it('null phase returns full tool set (backwards compatible)', () => {
    const defs = conversationMcpToolDefinitionsForPhase(null)
    const names = toolNames(defs)

    assert.ok(names.includes('propose_task_draft'))
    assert.ok(names.includes('get_task_draft'))
    assert.ok(names.includes('update_task_draft'))
    assert.ok(names.includes('confirm_requirements_contract'))
  })

  it('toolsForWizardPhase draft_review does not include propose_task_draft', () => {
    const names = toolsForWizardPhase(WIZARD_PHASE_DRAFT_REVIEW)

    assert.ok(!names.includes('propose_task_draft'))
    assert.ok(names.includes('get_task_draft'))
    assert.ok(names.includes('update_task_draft'))
  })
})
