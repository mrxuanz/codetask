import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { bootstrapRuntime, resetAppContextForTests } from '../../src/server/bootstrap.ts'
import {
  appendBusinessSkillSnapshot,
  loadBusinessSkillsSettings,
  resolveBusinessSkillSnapshot,
  saveBusinessSkillsSettings
} from '../../src/server/settings/business-skills.ts'

test('business skills are editable, extensible, and assigned by workflow', async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'codetask-business-skills-'))
  t.after(async () => {
    await resetAppContextForTests()
    rmSync(dataDir, { recursive: true, force: true })
  })
  bootstrapRuntime({ dataDir })

  const defaults = loadBusinessSkillsSettings()
  assert.ok(defaults.assignments.conversation.includes('conversation-read-only'))
  assert.match(resolveBusinessSkillSnapshot('planner').instructions, /short worker session/)
  assert.match(resolveBusinessSkillSnapshot('taskWorker').instructions, /assigned task/)

  const saved = saveBusinessSkillsSettings({
    ...defaults,
    skills: [
      ...defaults.skills,
      {
        id: 'domain-release-policy',
        name: 'Release policy',
        description: 'Apply the product release boundary.',
        instructions: 'Keep public API changes backward compatible.',
        enabled: true
      }
    ],
    assignments: {
      ...defaults.assignments,
      planner: [...defaults.assignments.planner, 'domain-release-policy']
    }
  })

  assert.equal(saved.revision, defaults.revision + 1)
  const snapshot = resolveBusinessSkillSnapshot('planner')
  assert.ok(snapshot.skillIds.includes('domain-release-policy'))
  assert.match(snapshot.instructions, /backward compatible/)
  assert.match(appendBusinessSkillSnapshot('BASE', snapshot), /## Business skills/)

  const cleared = saveBusinessSkillsSettings({
    revision: saved.revision,
    skills: [],
    assignments: {
      conversation: [],
      draft: [],
      planner: [],
      taskWorker: [],
      sliceVerifier: [],
      milestoneVerifier: []
    }
  })
  assert.deepEqual(cleared.skills, [])
  assert.deepEqual(loadBusinessSkillsSettings().skills, [])
  assert.throws(() => saveBusinessSkillsSettings(defaults), /revision conflict/)
})
