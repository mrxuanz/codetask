import type { PublicApiClient } from '../api/client'
import * as ops from '../api/operations'
import type { Capability } from '../mcp/capabilities'
import type { OperationLedger } from '../reports/ledger'

export type OracleResult = {
  name: string
  passed: boolean
  detail?: unknown
}

export async function runHttpStateOracle(input: {
  client: PublicApiClient
  expectations: {
    projectId?: string
    threadId?: string
    requireAssistantMessage?: boolean
    requireTurnCompleted?: boolean
    turnId?: string
    expectedCoreCode?: string
  }
}): Promise<OracleResult[]> {
  const results: OracleResult[] = []
  const { expectations, client } = input

  if (expectations.projectId) {
    const result = await client.request(
      'GET',
      `/api/projects/${expectations.projectId}`,
      undefined,
      {
        operationId: 'oracle.project.get'
      }
    )
    results.push({
      name: 'project_exists',
      passed: result.status === 200 && Boolean((result.data as { id?: string })?.id),
      detail: { status: result.status }
    })
  }

  if (expectations.threadId) {
    const thread = await ops.getThread(client, expectations.threadId)
    results.push({
      name: 'thread_exists',
      passed: String(thread.id ?? '') === expectations.threadId,
      detail: { id: thread.id }
    })

    if (expectations.expectedCoreCode) {
      const actualCoreCode = String(thread.coreCode ?? thread.core_code ?? '')
      results.push({
        name: 'thread_core_matches_provider',
        passed: actualCoreCode === expectations.expectedCoreCode,
        detail: { expected: expectations.expectedCoreCode, actual: actualCoreCode }
      })
    }

    if (expectations.requireAssistantMessage) {
      const messages = await ops.listMessages(client, expectations.threadId)
      const hasAssistant = messages.some((item) => item.role === 'assistant')
      results.push({
        name: 'assistant_message_present',
        passed: hasAssistant,
        detail: { messageCount: messages.length }
      })
    }

    if (expectations.requireTurnCompleted && expectations.turnId) {
      const { turn } = await ops.getTurn(client, expectations.threadId, expectations.turnId)
      results.push({
        name: 'turn_completed',
        passed: String(turn.status) === 'completed',
        detail: { status: turn.status }
      })
    }
  }

  return results
}

export function runLedgerOracle(input: {
  ledger: OperationLedger
  caseRunId: string
  requiredOperations: string[]
}): OracleResult {
  const missing = input.requiredOperations.filter(
    (op) => !input.ledger.hasOperation(input.caseRunId, op)
  )
  return {
    name: 'required_operations',
    passed: missing.length === 0,
    detail: { missing, required: input.requiredOperations }
  }
}

export function runAgentReportOracle(capability: Capability | undefined): OracleResult {
  if (!capability?.agentReport) {
    return { name: 'agent_report', passed: false, detail: { reason: 'agent_no_report' } }
  }
  return {
    name: 'agent_report',
    passed: capability.agentReport.status === 'completed',
    detail: {
      status: capability.agentReport.status,
      summary: capability.agentReport.summary
    }
  }
}

export function runProcessOracle(input: {
  serverPid: number
  serverStillAlive: boolean
  casePidsAlive: number[]
}): OracleResult[] {
  return [
    {
      name: 'server_alive',
      passed: input.serverStillAlive,
      detail: { serverPid: input.serverPid }
    },
    {
      name: 'no_case_process_leak',
      passed: input.casePidsAlive.length === 0,
      detail: { leaked: input.casePidsAlive }
    }
  ]
}

export function allPassed(results: OracleResult[]): boolean {
  return results.every((item) => item.passed)
}
