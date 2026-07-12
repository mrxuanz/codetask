import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  OPENCODE_AUTO_QUESTION_GUIDANCE,
  buildOpencodeAutoQuestionAnswers,
  resolveOpencodePermissionConfig,
  resolveOpencodeToolsConfig
} from '../../src/server/agent-runtime/providers/opencode-config.ts'

describe('OpenCode question policy', () => {
  it('denies interactive question while allowing other tools', () => {
    const permission = resolveOpencodePermissionConfig()
    assert.ok(permission && typeof permission === 'object')
    const rules = permission as { '*'?: string; question?: string }
    assert.equal(rules['*'], 'allow')
    assert.equal(rules.question, 'deny')
    assert.equal(resolveOpencodeToolsConfig().question, false)
  })

  it('auto-replies with the first (recommended) option label', () => {
    const answers = buildOpencodeAutoQuestionAnswers([
      {
        options: [
          { label: 'Proceed with docs cleanup', description: 'recommended' },
          { label: 'Ask later', description: 'defer' }
        ]
      },
      {
        options: [{ label: 'Use TypeScript', description: '' }],
        multiple: true
      }
    ])
    assert.deepEqual(answers, [['Proceed with docs cleanup'], ['Use TypeScript']])
  })

  it('falls back to guidance text when options are missing', () => {
    const answers = buildOpencodeAutoQuestionAnswers([{ options: [] }, { options: undefined }])
    assert.deepEqual(answers, [
      [OPENCODE_AUTO_QUESTION_GUIDANCE],
      [OPENCODE_AUTO_QUESTION_GUIDANCE]
    ])
  })
})
