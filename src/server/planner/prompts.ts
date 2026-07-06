import { PRODUCTION_LANDING_QUALITY_BAR } from '../conversation/prompts'
import type { TaskLaunchDraftPayload, TaskLaunchDraftReference } from '../conversation/draft/types'
import {
  resolveAttachmentRelativePath,
  resolveMessageAttachmentAbsolutePath
} from '../conversation/attachments'
import { resolveAttachmentAbsolutePath, resolveLocalCorpusPath } from '../reference-corpus/paths'
import { getAppContext } from '../bootstrap'

export function buildPlannerSystemPrompt(): string {
  return `You are an expert software architect and project manager.
Your task is to break down a software development requirement into a structured execution plan.

## Production quality bar (applies to EVERY task you register)
${PRODUCTION_LANDING_QUALITY_BAR}

## CRITICAL: Register the full plan through MCP tools only

You have access to MCP tools — their full parameter schemas are provided by the MCP server:

- **register_task_context**: registers the self-contained execution context for one task.
  Supply the 1-based milestone/slice/task indices, the exact taskTitle you will later use in register_plan,
  and a detailed content string.
  The content MUST include relevant file paths, interface contracts, data models, acceptance criteria,
  and any code patterns the executor needs.
  When this task will receive draft referenceIds in register_plan, summarize each assigned reference in the
  task context (what to match from the image/file description) and cite the reference id.
  Plans and task contexts must be minimal, high-signal, and free of filler.
  Be dense about boundaries, dependencies, and contracts, but do not omit key implementation constraints.
  Use this exact Section 1 structure:
  ### Read First
  ### Files
  ### Constraints
  ### Do
  ### Done When
  In **Constraints**, include this sentence verbatim: ${PRODUCTION_LANDING_QUALITY_BAR}
  Keep the block repair-friendly with a soft budget:
  - simple tasks: usually 600-1200 characters
  - default target: usually 900-1500 characters
  - cross-boundary or integration tasks may stretch to roughly 2500 characters when necessary
  Reference source artifacts by path instead of copying large sections.
  Do NOT inline full file contents, long markdown templates, or draft full README/HANDOFF/VERIFICATION documents inside task contexts.
  Do NOT inline full README/HANDOFF/VERIFICATION drafts,
  curl commands, or large tables unless a tiny excerpt is absolutely necessary.

- **register_plan**: registers the final structured plan once all task contexts are registered.
  Supply the complete ordered milestone list, where each milestone contains slices and each slice contains tasks.
  Each milestone, slice, and task must include a detailed successCriteria string.
  Each task must include an explicit abilityCode from the confirmed draft ability list (see user message) and an explicit taskKind from:
  project-setup, dependency-management, scaffolding, backend-implementation, frontend-implementation,
  data-modeling, testing-validation, documentation-handoff, general-implementation.
  taskKind describes the work shape; abilityCode must be one of the draft-confirmed abilities with a selected CLI.
  abilityCode values outside the confirmed draft list are rejected at register_plan.
  When draft references are available, referenceIds must contain only exact ids listed in the frozen draft references. Assign the smallest safe subset to each task and explain the mapping in referenceReason.
  If no frozen draft references are listed in the user message, every task's referenceIds must be [] or omitted.
  Never use draftId, sourceMessageId, file paths, artifact ids, or task ids as referenceIds.
  Missing taskKind values are rejected; the system does not infer task intent from titles, descriptions, or file names.
  The plan must be success-criteria oriented: milestones, slices, and tasks each include a detailed successCriteria string describing observable outcomes, key files, and completion signals. Tasks may also include dependencies, requiredInputs, and canRunInParallel where relevant.

- **update_task_context**: revise a previously registered task context during planning. Use the same indices and taskTitle as register_task_context.

**Workflow you MUST follow:**
1. Design the full plan (milestones → slices → tasks) in your head first.
2. For EVERY task, call register_task_context with the correct indices, the same title you will use in register_plan, and a fully self-contained content block.
3. After ALL register_task_context calls succeed, call register_plan once with the final structured plan.
4. After register_plan succeeds, respond with a short plain-text confirmation only.

The tools return a success message on success, or an error message if parameters are invalid.
If a tool call returns an error, fix the parameters and retry before proceeding.

## Planning rules — keep plans reasonable and tasks small
- Use as many Milestones as the work truly needs; multiple milestones are fine.
- Each Milestone may have multiple Slices; each Slice represents one demonstrable vertical increment.
- Each Slice may have multiple small Tasks. Each Task must be completable in a single AI coding session (~10 minutes).
- Prefer more small tasks over a few huge tasks. Do not create monolithic tasks that mix unrelated concerns.
- Split UI work into one task per component or cohesive file (e.g. Header.vue, PostList.vue, App.vue composition are separate tasks).
- Avoid documentation-only filler tasks, but do NOT collapse multiple implementation units into one task.
- Treat the provided source artifacts as the ground truth
- Each task context (registered via tool) must cite relevant source artifact paths
- taskKind: choose it explicitly for every task. Use project-setup for config/package scaffolding, dependency-management for package/lockfile/dependency installation, scaffolding for tracked directory skeletons such as .gitkeep placeholders, and backend/frontend-implementation only for real business source changes.
- Do not generate shell commands, verification scripts, package scripts, test commands, build commands, lint commands, smoke commands, or validation steps.
- Your job is to produce a success-criteria-oriented plan: milestones, slices, and tasks each include detailed successCriteria text. Tasks may include requiredInputs, explicit dependencies, and repair-friendly context.
- When draft references are available, do not leave every task's referenceIds empty. Assign the smallest safe subset you can justify; only fall back to broader coverage when a task truly needs it. If a specific task does not need references, leave referenceIds empty and say why in referenceReason.
- If the user explicitly asks to run a command, represent that as a normal task goal for a worker, not as a verification gate.
- Project inventories and manifests are static facts only. Do not infer runnable commands from them.
- abilityCode: assign the MOST appropriate ability from the **confirmed draft ability list only** (not the full catalog). If no ability fits exactly, pick the closest confirmed ability and keep taskKind precise.
- Order by natural execution order (dependencies first)
- Use relative workspace paths in successCriteria and requiredInputs when citing files. Do not copy absolute paths from source artifacts or user text into these structured fields.
- Use canonical planner-local dependency refs: slices as m1-s1, m1-s2, etc.; tasks as m1-s1-t1, m1-s1-t2, etc. Put task refs only in dependsOnTaskRefs and slice refs only in dependsOnSliceRefs.
- Multi-slice plans MUST declare cross-slice or cross-task dependencies; do not leave all dependsOn* arrays empty
- Do NOT include debugging or investigation tasks`
}

function resolveDraftReferenceDisplayPath(
  threadId: string,
  ref: TaskLaunchDraftReference,
  dataDir = getAppContext().dataDir
): string | null {
  if (ref.source === 'local_corpus' && ref.localPath?.trim()) {
    try {
      return resolveLocalCorpusPath(ref.localPath)
    } catch {
      return null
    }
  }

  const relativePath = resolveAttachmentRelativePath(threadId, ref.id)
  if (!relativePath) return null
  try {
    return resolveAttachmentAbsolutePath(dataDir, threadId, relativePath)
  } catch {
    return null
  }
}

function formatDraftReferenceIndexLine(
  threadId: string,
  ref: TaskLaunchDraftReference,
  sourceAttachments: TaskLaunchDraftPayload['sourceAttachments']
): string {
  const fromAttachment = sourceAttachments?.find((item) => item.id === ref.id)
  const absolutePath =
    (fromAttachment ? resolveMessageAttachmentAbsolutePath(threadId, fromAttachment) : null) ??
    resolveDraftReferenceDisplayPath(threadId, ref)
  const pathLine = absolutePath ? `\n  path: ${absolutePath}` : ''
  return `- ${ref.name} (${ref.kind})\n  id: ${ref.id}${pathLine}`
}

function buildFrozenReferenceSection(
  references: TaskLaunchDraftReference[],
  threadId?: string
): string {
  if (references.length === 0) {
    return [
      '## Frozen Draft References',
      'No frozen draft references are available for this task.',
      '- Set referenceIds to [] or omit it for every task.',
      '- Do not use draftId, sourceMessageId, artifact ids, file paths, task refs, or invented ids as referenceIds.'
    ].join('\n')
  }

  const lines = [
    '## Frozen Draft References',
    'Use only these exact ids in task.referenceIds. Do not substitute draftId, sourceMessageId, artifact ids, file paths, task refs, or invented ids.',
    ...references.map((reference) => {
      const parts = [
        `- id: ${reference.id}`,
        `  name: ${reference.name}`,
        `  kind: ${reference.kind}`
      ]
      if (threadId) {
        const displayPath = resolveDraftReferenceDisplayPath(threadId, reference)
        if (displayPath) {
          parts.push(`  path: ${displayPath}`)
        }
      }
      if (reference.description?.trim()) {
        parts.push(`  description: ${reference.description.trim()}`)
      } else {
        parts.push('  description: (missing — planner should still assign only when unavoidable)')
      }
      return parts.join('\n')
    })
  ]
  return lines.join('\n')
}

function formatAcceptanceCriteria(draft: TaskLaunchDraftPayload): string {
  if (!draft.acceptance?.length) return 'None specified'
  return draft.acceptance
    .map((item, index) =>
      [`${index + 1}. Given ${item.given}`, `   When ${item.when}`, `   Then ${item.then}`].join(
        '\n'
      )
    )
    .join('\n')
}

export function buildPlannerUserMessage(input: {
  draft: TaskLaunchDraftPayload
  workspacePath: string
  threadId?: string
}): string {
  const draft = input.draft
  const threadId = input.threadId
  const abilitiesList = draft.abilities
    .map(
      (ability) =>
        `- ${ability.abilityCode}: ${ability.label} — ${ability.reason} (preferred core: ${ability.recommendedCoreCode})`
    )
    .join('\n')

  const taskKindReference = [
    'project-setup',
    'dependency-management',
    'scaffolding',
    'backend-implementation',
    'frontend-implementation',
    'data-modeling',
    'testing-validation',
    'documentation-handoff',
    'general-implementation'
  ]
    .map((code) => `- ${code}`)
    .join('\n')

  const referenceIndex =
    draft.references.length > 0
      ? threadId
        ? draft.references
            .map((item) => formatDraftReferenceIndexLine(threadId, item, draft.sourceAttachments))
            .join('\n')
        : draft.references
            .map(
              (item) => `- ${item.name} (${item.kind})\n  id: ${item.id}\n  path: ${item.assetUrl}`
            )
            .join('\n')
      : '- No source references available'

  const referenceSection = buildFrozenReferenceSection(draft.references, threadId)

  const nfrSection =
    draft.nfr.length > 0 ? draft.nfr.map((item) => `- ${item}`).join('\n') : '- None specified'

  const outOfScopeSection =
    draft.outOfScope.length > 0
      ? draft.outOfScope.map((item) => `- ${item}`).join('\n')
      : '- None specified'

  return [
    `## Task: ${draft.title}`,
    '',
    '## Context Summary',
    '',
    draft.summary,
    '',
    '## User Flow',
    '',
    draft.userFlow || 'Not specified',
    '',
    '## Tech Stack / Scope',
    '',
    draft.techStack || 'Not specified',
    '',
    '## REQUIREMENTS CONTRACT',
    '',
    draft.requirementsContract.markdown,
    '',
    '## Acceptance Criteria (Given / When / Then)',
    '',
    formatAcceptanceCriteria(draft),
    '',
    '## Non-functional Requirements',
    '',
    nfrSection,
    '',
    '## Out of Scope',
    '',
    outOfScopeSection,
    '',
    '## Source Reference Index',
    '',
    referenceIndex,
    '',
    referenceSection,
    '',
    '## Confirmed Draft Abilities (use ONLY these for task.abilityCode)',
    '',
    abilitiesList ||
      '- (none configured — register_plan will reject any abilityCode until draft abilities are confirmed)',
    '',
    '## Task kind reference (for task.taskKind only — not for abilityCode)',
    '',
    taskKindReference,
    '',
    '## Workspace',
    '',
    draft.workspacePath || input.workspacePath,
    '',
    '## Production quality bar',
    '',
    PRODUCTION_LANDING_QUALITY_BAR,
    '',
    '## Plan shape reminder',
    '- Multiple milestones and multiple slices are fine; keep each task small (~10 minutes).',
    '- Typical feature plan: milestone 1 = project setup (1 slice, 1-2 tasks); milestone 2+ = implementation with multiple slices and multiple tasks per slice.',
    '- Example decomposition for a UI feature: scaffold project → implement each component/file as its own task → compose page/layout → polish styles.',
    '- Plans with only 2 total tasks will be rejected. Implementation milestones should not collapse multiple files/components into one task.',
    '',
    'Call register_task_context for every task, then call register_plan once with the final success-criteria-oriented structure.',
    'Each milestone, slice, and task needs a detailed successCriteria string (observable outcomes, key files, completion signals).',
    'Use update_task_context to revise a task context before register_plan when needed.',
    'Do not include runnable validation command fields in the plan.'
  ].join('\n')
}

export function buildTaskWorkerPrompt(input: {
  taskTitle: string
  contextMarkdown: string
  workspacePath: string
}): string {
  return [
    `Execute this single planned task in the workspace: ${input.workspacePath}`,
    '',
    `## Task: ${input.taskTitle}`,
    '',
    input.contextMarkdown,
    '',
    'Complete the implementation directly in the workspace. Reply with a brief summary of what you changed.'
  ].join('\n')
}

export function buildTaskWorkerSystemPrompt(): string {
  return `You are a focused software engineer executing one planned task.
${PRODUCTION_LANDING_QUALITY_BAR}
Stay within the task scope, modify only what is needed, and finish with a concise summary.`
}
