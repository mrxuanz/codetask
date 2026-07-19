import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { redactValue } from './redaction'

export type LedgerEntry = {
  at: string
  caseRunId?: string
  operationId: string
  transport: 'http' | 'mcp' | 'sse' | 'process'
  method?: string
  routeOrTool: string
  status?: number | string
  ok: boolean
  detail?: unknown
}

export class OperationLedger {
  private readonly entries: LedgerEntry[] = []
  private readonly path: string

  constructor(reportsDir: string) {
    this.path = join(reportsDir, 'operation-ledger.jsonl')
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileSync(this.path, '', 'utf8')
  }

  record(entry: Omit<LedgerEntry, 'at'> & { at?: string }): void {
    const full: LedgerEntry = {
      at: entry.at ?? new Date().toISOString(),
      ...entry,
      detail: entry.detail !== undefined ? redactValue(entry.detail) : undefined
    }
    this.entries.push(full)
    appendFileSync(this.path, `${JSON.stringify(full)}\n`, 'utf8')
  }

  list(caseRunId?: string): LedgerEntry[] {
    if (!caseRunId) return [...this.entries]
    return this.entries.filter((item) => item.caseRunId === caseRunId)
  }

  hasOperation(caseRunId: string, operationId: string): boolean {
    return this.entries.some(
      (item) => item.caseRunId === caseRunId && item.operationId === operationId
    )
  }

  snapshot(): LedgerEntry[] {
    return [...this.entries]
  }
}
