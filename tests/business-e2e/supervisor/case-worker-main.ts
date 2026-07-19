import { writeFileSync } from 'node:fs'
import { FakeDriver } from '../drivers/fake'
import { OpenCodeDriver } from '../drivers/opencode'
import { readJson } from './run-layout'
import type { CaseWorkerInput, CaseWorkerResult } from './case-process'

function readArg(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name)
  return index >= 0 ? argv[index + 1] : undefined
}

async function main(): Promise<void> {
  const contextPath = readArg(process.argv, '--context')
  if (!contextPath) throw new Error('worker.context_required')
  const input = readJson<CaseWorkerInput>(contextPath)

  const driver =
    input.driver === 'opencode' ? new OpenCodeDriver() : new FakeDriver()

  let fixture: Record<string, unknown> | undefined
  if (input.fixturePath) {
    fixture = readJson<Record<string, unknown>>(input.fixturePath)
  }

  const result = await driver.start({
    caseId: input.caseId,
    caseRunId: input.caseRunId,
    skillPaths: input.skillPaths,
    mcpUrl: input.mcpUrl,
    capabilityId: input.capabilityId,
    workspaceRoot: input.workspaceRoot,
    agentRoot: input.agentRoot,
    fixture,
    timeoutMs: input.timeoutMs,
    conversationCore: input.conversationCore,
    expectedHtmlFile: input.expectedHtmlFile,
    probeMcpUrl: input.probeMcpUrl,
    probeMcpName: input.probeMcpName
  })

  const payload: CaseWorkerResult = {
    ok: result.ok,
    classification: result.classification,
    error: result.error,
    events: result.events
  }
  writeFileSync(input.resultPath, JSON.stringify(payload, null, 2), 'utf8')
  await driver.cleanup()
  process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
  const contextPath = readArg(process.argv, '--context')
  if (contextPath) {
    try {
      const input = readJson<CaseWorkerInput>(contextPath)
      writeFileSync(
        input.resultPath,
        JSON.stringify(
          {
            ok: false,
            classification: 'runner_crash',
            error: String(error)
          } satisfies CaseWorkerResult,
          null,
          2
        ),
        'utf8'
      )
    } catch {
      /* ignore */
    }
  }
  console.error(error)
  process.exit(1)
})
