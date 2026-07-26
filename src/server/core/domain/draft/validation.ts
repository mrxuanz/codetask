import { basename, isAbsolute } from 'node:path'
import { DraftError } from './draft-error'
import {
  EXECUTION_TASK_KINDS,
  type DraftContent,
  type ExecutionMilestone,
  type ExecutionSlice,
  type ExecutionTask,
  type ExecutionTaskKind,
  type ExecutionTree
} from './types'

const MAX_TREE_RESPONSE_BYTES = 2 * 1024 * 1024

function text(value: unknown, field: string, max: number, required = true): string {
  if (typeof value !== 'string') throw new DraftError('draft.tree_invalid', { field })
  const result = value.trim()
  if ((required && !result) || result.length > max) {
    throw new DraftError('draft.tree_invalid', { field })
  }
  return result
}

function list(value: unknown, field: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new DraftError('draft.tree_invalid', { field })
  }
  return value
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DraftError('draft.tree_invalid', { field })
  }
  return value as Record<string, unknown>
}

function stringList(value: unknown, field: string, maxItems: number, maxText: number): string[] {
  return list(value, field, 0, maxItems).map((item, index) =>
    text(item, `${field}.${index}`, maxText)
  )
}

function validateWorkspaceRelativePath(value: string, field: string): string {
  const normalized = value.replaceAll('\\', '/')
  if (
    isAbsolute(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    normalized.startsWith('/') ||
    normalized.split('/').includes('..') ||
    normalized.includes('\0') ||
    basename(normalized) === ''
  ) {
    throw new DraftError('draft.tree_invalid_path', { field, path: value })
  }
  return normalized.replace(/^\.\//, '')
}

export function validateDraftContent(input: Partial<DraftContent>): DraftContent {
  return {
    title: text(input.title, 'title', 160),
    objective: text(input.objective, 'objective', 4_000),
    requirements: text(input.requirements, 'requirements', 40_000),
    constraints: text(input.constraints ?? '', 'constraints', 20_000, false),
    acceptanceCriteria: text(input.acceptanceCriteria, 'acceptanceCriteria', 20_000)
  }
}

export function validateDraftModel(value: unknown): string | null {
  if (value === undefined || value === null) return null
  const model = text(value, 'model', 120, false)
  return model || null
}

export function validateEditablePlanningText(
  value: unknown,
  field: 'plannerPrompt' | 'skillsManual'
): string | null {
  if (value === undefined || value === null) return null
  const result = text(value, field, 100_000, false)
  return result || null
}

export function validateAttachmentName(value: string): string {
  const name = [...basename(value.trim())]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0
      return code < 32 || code === 127 ? '_' : character
    })
    .join('')
  if (!name || name === '.' || name === '..' || name.length > 240) {
    throw new DraftError('draft.attachment_name_invalid')
  }
  return name
}

function extractJson(response: string): unknown {
  if (Buffer.byteLength(response, 'utf8') > MAX_TREE_RESPONSE_BYTES) {
    throw new DraftError('draft.tree_response_too_large')
  }
  let candidate = response.trim()
  const fence = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fence?.[1]) candidate = fence[1].trim()
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first < 0 || last <= first) throw new DraftError('draft.tree_invalid_json')
  try {
    return JSON.parse(candidate.slice(first, last + 1))
  } catch {
    throw new DraftError('draft.tree_invalid_json')
  }
}

export function parseExecutionTree(
  response: string,
  allowedAttachmentIds: ReadonlySet<string>
): ExecutionTree {
  const root = object(extractJson(response), 'root')
  if (root.schemaVersion !== 1) {
    throw new DraftError('draft.tree_invalid', { field: 'schemaVersion' })
  }
  const seenSlices = new Set<string>()
  const seenTasks = new Set<string>()
  let totalTasks = 0

  const milestones: ExecutionMilestone[] = list(root.milestones, 'milestones', 1, 20).map(
    (rawMilestone, milestoneIndex) => {
      const value = object(rawMilestone, `milestones.${milestoneIndex}`)
      const milestoneId = `m${milestoneIndex + 1}`
      if (value.id !== milestoneId) {
        throw new DraftError('draft.tree_invalid_id', {
          field: `milestones.${milestoneIndex}.id`,
          expected: milestoneId
        })
      }
      const slices: ExecutionSlice[] = list(value.slices, `${milestoneId}.slices`, 1, 20).map(
        (rawSlice, sliceIndex) => {
          const sliceValue = object(rawSlice, `${milestoneId}.slices.${sliceIndex}`)
          const sliceId = `${milestoneId}-s${sliceIndex + 1}`
          if (sliceValue.id !== sliceId) {
            throw new DraftError('draft.tree_invalid_id', {
              field: `${sliceId}.id`,
              expected: sliceId
            })
          }
          const sliceDependencies = stringList(
            sliceValue.dependsOn ?? [],
            `${sliceId}.dependsOn`,
            30,
            80
          )
          for (const dependency of sliceDependencies) {
            if (!seenSlices.has(dependency)) {
              throw new DraftError('draft.tree_invalid_dependency', {
                field: `${sliceId}.dependsOn`,
                dependency
              })
            }
          }

          const tasks: ExecutionTask[] = list(sliceValue.tasks, `${sliceId}.tasks`, 1, 30).map(
            (rawTask, taskIndex) => {
              totalTasks += 1
              if (totalTasks > 300) throw new DraftError('draft.tree_too_large')
              const taskValue = object(rawTask, `${sliceId}.tasks.${taskIndex}`)
              const taskId = `${sliceId}-t${taskIndex + 1}`
              if (taskValue.id !== taskId) {
                throw new DraftError('draft.tree_invalid_id', {
                  field: `${taskId}.id`,
                  expected: taskId
                })
              }
              const kind = text(taskValue.kind, `${taskId}.kind`, 80) as ExecutionTaskKind
              if (!EXECUTION_TASK_KINDS.includes(kind)) {
                throw new DraftError('draft.tree_invalid', { field: `${taskId}.kind` })
              }
              if (
                !Number.isInteger(taskValue.estimatedMinutes) ||
                Number(taskValue.estimatedMinutes) < 3 ||
                Number(taskValue.estimatedMinutes) > 15
              ) {
                throw new DraftError('draft.tree_invalid', {
                  field: `${taskId}.estimatedMinutes`
                })
              }
              const dependencies = stringList(
                taskValue.dependsOn ?? [],
                `${taskId}.dependsOn`,
                60,
                80
              )
              for (const dependency of dependencies) {
                if (!seenTasks.has(dependency)) {
                  throw new DraftError('draft.tree_invalid_dependency', {
                    field: `${taskId}.dependsOn`,
                    dependency
                  })
                }
              }
              const attachmentIds = stringList(
                taskValue.attachmentIds ?? [],
                `${taskId}.attachmentIds`,
                50,
                160
              )
              for (const attachmentId of attachmentIds) {
                if (!allowedAttachmentIds.has(attachmentId)) {
                  throw new DraftError('draft.tree_unknown_attachment', {
                    taskId,
                    attachmentId
                  })
                }
              }
              const task: ExecutionTask = {
                id: taskId,
                title: text(taskValue.title, `${taskId}.title`, 200),
                objective: text(taskValue.objective, `${taskId}.objective`, 2_000),
                kind,
                estimatedMinutes: Number(taskValue.estimatedMinutes),
                files: stringList(taskValue.files ?? [], `${taskId}.files`, 80, 400).map(
                  (file, fileIndex) =>
                    validateWorkspaceRelativePath(file, `${taskId}.files.${fileIndex}`)
                ),
                dependsOn: dependencies,
                acceptanceCriteria: stringList(
                  taskValue.acceptanceCriteria,
                  `${taskId}.acceptanceCriteria`,
                  12,
                  1_000
                ),
                attachmentIds
              }
              if (task.acceptanceCriteria.length === 0) {
                throw new DraftError('draft.tree_invalid', {
                  field: `${taskId}.acceptanceCriteria`
                })
              }
              seenTasks.add(taskId)
              return task
            }
          )
          const slice: ExecutionSlice = {
            id: sliceId,
            title: text(sliceValue.title, `${sliceId}.title`, 200),
            objective: text(sliceValue.objective, `${sliceId}.objective`, 2_000),
            successCriteria: text(sliceValue.successCriteria, `${sliceId}.successCriteria`, 2_000),
            dependsOn: sliceDependencies,
            tasks
          }
          seenSlices.add(sliceId)
          return slice
        }
      )
      return {
        id: milestoneId,
        title: text(value.title, `${milestoneId}.title`, 200),
        objective: text(value.objective, `${milestoneId}.objective`, 2_000),
        successCriteria: text(value.successCriteria, `${milestoneId}.successCriteria`, 2_000),
        slices
      }
    }
  )

  return {
    schemaVersion: 1,
    title: text(root.title, 'title', 200),
    summary: text(root.summary, 'summary', 4_000),
    milestones
  }
}
