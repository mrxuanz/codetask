import type { AgentRuntime, AgentTurnEvent, AgentTurnInput } from '@codetask/agent-runtime'

/** Test/runtime helper that completes turns immediately without a real provider. */
export class FakeAgentRuntime implements AgentRuntime {
  async *runTurn(input: AgentTurnInput): AsyncIterable<AgentTurnEvent> {
    if (input.signal?.aborted) {
      yield { type: 'failed', message: 'aborted' }
      return
    }
    if (input.role === 'slice-verifier') {
      yield {
        type: 'tool_call',
        name: 'complete_slice_verification',
        arguments: {
          status: 'progress-ok',
          confidence: 'high',
          summary: 'Fake slice verification passed',
          satisfiedSignals: ['fake-runtime'],
          missingSignals: [],
          questionableClaims: [],
          evidenceTrace: [],
          repairSuggestions: []
        }
      }
    } else if (input.role === 'milestone-verifier') {
      yield {
        type: 'tool_call',
        name: 'complete_milestone_verification',
        arguments: {
          status: 'passed',
          confidence: 'high',
          summary: 'Fake milestone verification passed',
          requirementTrace: [],
          sliceAssessments: [],
          repairTasks: []
        }
      }
    } else if (input.role === 'task-worker') {
      yield {
        type: 'tool_call',
        name: 'report_task_result',
        arguments: {
          status: 'completed',
          summary: 'Fake runtime completed',
          changedFiles: [],
          evidence: ['fake-runtime'],
          validation: { ran: false, outcome: 'not-applicable' }
        }
      }
    }
    yield { type: 'completed', reason: 'fake-runtime' }
  }

  async abort(): Promise<void> {
    // Fake turns are synchronous generators and have no background work to abort.
  }
  async closeScope(): Promise<void> {
    // Fake runtimes do not allocate reusable scopes.
  }
  async inspectScope(): Promise<null> {
    return null
  }
}
