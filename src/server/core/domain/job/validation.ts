import { isAbsolute } from 'node:path'
import { isSupportedCoreCode, type SupportedCoreCode } from '../../../../shared/providers/codes'
import { JobError } from './job-error'
import type { JobSettings, RepairTask, VerificationResult, WorkResult } from './types'

const MAX_TEXT = 40_000
const MAX_RESULT = 1_000_000
const MAX_REPAIRS = 3

function object(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new JobError(code)
  return value as Record<string, unknown>
}

function text(value: unknown, code: string, max = MAX_TEXT): string {
  if (typeof value !== 'string') throw new JobError(code)
  const result = value.trim()
  if (!result || result.length > max) throw new JobError(code)
  return result
}

function optionalText(value: unknown, code: string): string | null {
  if (value === undefined || value === null || value === '') return null
  return text(value, code, 200)
}

function stringList(value: unknown, code: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max) throw new JobError(code)
  return value.map((entry) => text(entry, code, 2_000))
}

export function assertWorkspaceRelativePath(value: string): void {
  const normalized = value.replaceAll('\\', '/')
  if (
    isAbsolute(value) ||
    normalized.startsWith('/') ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split('/').includes('..')
  ) {
    throw new JobError('job.result_path_invalid', { path: value })
  }
}

function extractJson(reply: string): unknown {
  if (reply.length > MAX_RESULT) throw new JobError('job.result_too_large')
  const trimmed = reply.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  const source = fenced?.[1] ?? trimmed
  try {
    return JSON.parse(source)
  } catch {
    const start = source.indexOf('{')
    const end = source.lastIndexOf('}')
    if (start < 0 || end <= start) throw new JobError('job.result_invalid_json')
    try {
      return JSON.parse(source.slice(start, end + 1))
    } catch {
      throw new JobError('job.result_invalid_json')
    }
  }
}

export function parseWorkResult(reply: string): WorkResult {
  const value = object(extractJson(reply), 'job.work_result_invalid')
  if (value.status !== 'completed') throw new JobError('job.work_result_invalid')
  const changedFiles = stringList(value.changedFiles, 'job.work_result_invalid')
  changedFiles.forEach(assertWorkspaceRelativePath)
  return {
    status: 'completed',
    summary: text(value.summary, 'job.work_result_invalid'),
    changedFiles,
    evidence: stringList(value.evidence, 'job.work_result_invalid')
  }
}

function repairTask(value: unknown): RepairTask {
  const record = object(value, 'job.verification_result_invalid')
  const files = stringList(record.files, 'job.verification_result_invalid', 30)
  files.forEach(assertWorkspaceRelativePath)
  return {
    title: text(record.title, 'job.verification_result_invalid', 200),
    objective: text(record.objective, 'job.verification_result_invalid', 4_000),
    files,
    acceptanceCriteria: stringList(record.acceptanceCriteria, 'job.verification_result_invalid', 20)
  }
}

export function parseVerificationResult(reply: string): VerificationResult {
  const value = object(extractJson(reply), 'job.verification_result_invalid')
  if (value.status !== 'passed' && value.status !== 'repair' && value.status !== 'failed') {
    throw new JobError('job.verification_result_invalid')
  }
  if (!Array.isArray(value.repairTasks) || value.repairTasks.length > MAX_REPAIRS) {
    throw new JobError('job.verification_result_invalid')
  }
  const repairTasks = value.repairTasks.map(repairTask)
  if (
    (value.status === 'repair' && repairTasks.length === 0) ||
    (value.status !== 'repair' && repairTasks.length !== 0)
  ) {
    throw new JobError('job.verification_result_invalid')
  }
  return {
    status: value.status,
    summary: text(value.summary, 'job.verification_result_invalid'),
    evidence: stringList(value.evidence, 'job.verification_result_invalid'),
    repairTasks
  }
}

function provider(value: unknown, code: string): SupportedCoreCode {
  if (typeof value !== 'string' || !isSupportedCoreCode(value)) throw new JobError(code)
  return value
}

function editable(value: unknown, fallback: string, code: string): string {
  if (value === undefined || value === null) return fallback
  return text(value, code)
}

export function validateJobSettingsInput(value: unknown, defaults: JobSettings): JobSettings {
  const input = object(value, 'job.settings_invalid')
  const role = (
    key: 'work' | 'workValidation' | 'sliceValidation' | 'milestoneValidation',
    fallback: JobSettings['work'],
    withEnabled: boolean
  ): JobSettings['work'] | JobSettings['workValidation'] => {
    const item = object(input[key], 'job.settings_invalid')
    const base = {
      provider: provider(item.provider, 'job.settings_invalid'),
      model: optionalText(item.model, 'job.settings_invalid'),
      prompt: editable(item.prompt, fallback.prompt, 'job.settings_invalid'),
      skillsManual: editable(item.skillsManual, fallback.skillsManual, 'job.settings_invalid')
    }
    if (!withEnabled) return base
    if (typeof item.enabled !== 'boolean') throw new JobError('job.settings_invalid')
    return { ...base, enabled: item.enabled }
  }
  if (input.maxConcurrentJobs !== 1 && input.maxConcurrentJobs !== 2) {
    throw new JobError('job.settings_invalid')
  }
  return {
    maxConcurrentJobs: input.maxConcurrentJobs,
    work: role('work', defaults.work, false) as JobSettings['work'],
    workValidation: role(
      'workValidation',
      defaults.workValidation,
      true
    ) as JobSettings['workValidation'],
    sliceValidation: role(
      'sliceValidation',
      defaults.sliceValidation,
      true
    ) as JobSettings['sliceValidation'],
    milestoneValidation: role(
      'milestoneValidation',
      defaults.milestoneValidation,
      true
    ) as JobSettings['milestoneValidation'],
    revision: defaults.revision,
    updatedAtMs: defaults.updatedAtMs
  }
}
