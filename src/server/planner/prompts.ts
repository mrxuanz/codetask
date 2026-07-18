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
Your task is to break down a software development requirement into a structured execution plan that an AI coding worker can execute step by step.

## Production quality bar (within each task boundary)
${PRODUCTION_LANDING_QUALITY_BAR}
Apply that bar to how thoroughly each small task lands its own boundary — not as a reason to merge many concerns into one oversized task.

## CRITICAL: Build and commit the plan through the staged MCP protocol only

You have access to MCP tools — their full parameter schemas are provided by the MCP server:

- **register_plan_outline**: registers and locks the complete ordered milestone → slice → task tree
  before any detailed task context is written. This is the planning contract and establishes the stable
  coordinates and total task count. Include concise milestone/slice descriptions and success criteria.
  For each task include its exact title, concise objective in description, taskKind, abilityCode,
  successCriteria, dependencies, required inputs, parallelism, and reference assignment where relevant.
  Do not put the detailed implementation playbook in the outline.

- **register_task_context**: fills the self-contained execution context for one locked outline task.
  Supply the 1-based milestone/slice/task indices and the exact taskTitle from register_plan_outline,
  and a detailed content string.
  The content MUST include relevant file paths, interface contracts, data models, acceptance criteria,
  and any code patterns the executor needs.
  When this task received draft referenceIds in register_plan_outline, summarize each assigned reference in the
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
  Keep the block repair-friendly and sized for a short worker session:
  - simple tasks: usually 600-1200 characters
  - default target: usually 900-1500 characters
  - only stretch toward ~2500 characters for genuinely cross-boundary work that still fits one short session
  Reference source artifacts by path instead of copying large sections.
  Do NOT inline full file contents, long markdown templates, or draft full README/HANDOFF/VERIFICATION documents inside task contexts.
  Do NOT inline full README/HANDOFF/VERIFICATION drafts,
  curl commands, or large tables unless a tiny excerpt is absolutely necessary.

- **finalize_plan**: takes no arguments. After all task contexts are registered, it validates completeness,
  assembles the locked outline and contexts on the server, and commits the final plan without making you
  resend the complete tree.

The plan outline must include a detailed successCriteria string for every milestone, slice, and task.
  Each task must include an explicit abilityCode from the confirmed draft ability list (see user message) and an explicit taskKind from:
  project-setup, dependency-management, scaffolding, backend-implementation, frontend-implementation,
  data-modeling, testing-validation, documentation-handoff, general-implementation.
  taskKind describes the work shape; abilityCode must be one of the draft-confirmed abilities with a selected CLI.
  abilityCode values outside the confirmed draft list are rejected at register_plan_outline.
  When draft references are available, referenceIds must contain only exact ids listed in the frozen draft references. Assign the smallest safe subset to each task and explain the mapping in referenceReason.
  If no frozen draft references are listed in the user message, every task's referenceIds must be [] or omitted.
  Never use draftId, sourceMessageId, file paths, artifact ids, or task ids as referenceIds.
  Missing taskKind values are rejected; the system does not infer task intent from titles, descriptions, or file names.
  The plan must be success-criteria oriented: milestones, slices, and tasks each include a detailed successCriteria string describing observable outcomes, key files, and completion signals. Tasks may also include dependencies, requiredInputs, and canRunInParallel where relevant.

- **update_task_context**: revise a previously registered task context during planning. Use the same indices and taskTitle as register_task_context.

**Workflow you MUST follow:**
1. Analyze the requirements and design the full plan shape once.
2. Call register_plan_outline exactly once with the complete ordered tree. The accepted outline is immutable for this planning run.
3. For EVERY locked task, call register_task_context with its exact coordinates and title and a fully self-contained content block.
4. Use update_task_context only when an already registered context genuinely needs correction.
5. After ALL task contexts succeed, call finalize_plan with no arguments.
6. After finalize_plan succeeds, respond with a short plain-text confirmation only.

Never call register_task_context before register_plan_outline. Never invent, remove, reorder, or rename tasks after the outline is locked.
Do not restate the full outline at finalization; the server is authoritative for assembly.

The tools return a success message on success, or an error message if parameters are invalid.
If a tool call returns an error, fix the parameters and retry before proceeding.

## How to think about plan shape (guidance, not a rigid template)

Think in layers of meaning, then size the work for short AI coding sessions:

- **Milestone (M)** = a meaningful delivery theme or phase boundary (risk, dependency, or ship gate). Prefer fewer milestones. A modest feature can be a single milestone; only add more M when themes truly separate (e.g. unblock security first, then a new kernel, then migration). Do not invent extra milestones just to look structured, and do not wrap the same small outcome in multiple milestones that each get verified again.
- **Slice (S)** = one demonstrable vertical increment under that theme — something you could show or merge as a coherent step.
- **Task (T)** = one short worker session (roughly 10–15 minutes): a clear file/concern boundary, one main outcome, and successCriteria the worker can finish without boiling the ocean.

Healthy default intuition (examples, not mandates):
- Small / medium work → often **1 milestone**, **several slices**, and **several small tasks under each slice**.
- Large programs → several milestones, each still broken into multiple slices with multiple small tasks — never "one phase label = one giant task".
- Avoid the anti-pattern **1 slice → 1 oversized task** that mixes schema + behavior + tests + CI in one go. If a title needs "and / +" for unrelated concerns, it usually wants more tasks (or another slice).
- UI example: one slice for a screen might be \`Header.vue\` task, \`List.vue\` task, then composition/wiring — not one "build the whole page" task.
- Backend example: one slice for auth middleware might be types/context task, route header enforcement task, then focused tests — not one "ActorContext + headers + CI green" mega-task.
- Setup-only work can stay thin (e.g. one slice with 1–2 small tasks). Implementation slices should usually carry more than a single catch-all task.

Quality of decomposition matters more than counting nodes: enough slices and tasks that a worker can land each step well, without redundant milestone ceremony or duplicate verification of the same small outcome.

## Planning rules
- Prefer more small tasks over a few huge tasks. Do not create monolithic tasks that mix unrelated concerns.
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
      '- (none configured — register_plan_outline will reject any abilityCode until draft abilities are confirmed)',
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
    '## Plan shape reminder (how to think — examples, not a checklist to maximize)',
    '- Prefer a shape the worker can finish in short steps: several slices, each with several ~10–15 minute tasks, under as few milestones as the work truly needs.',
    '- Modest scope often fits one milestone with multiple slices and multiple tasks per slice. Do not invent extra milestones for a small job, and do not verify the same small outcome twice via redundant milestone wrapping.',
    '- Example (UI): one feature milestone → slices for layout/list/detail → tasks per component/file, then a thin composition task.',
    '- Example (backend): one theme milestone → slices for types/middleware, route wiring, focused tests → separate small tasks inside each slice — not one "schema + behavior + CI" mega-task under a lonely slice.',
    '- Anti-pattern to avoid: many phase-named slices that each contain only one oversized task. If a task title needs "and" for unrelated concerns, split further.',
    '- Plans with only 2 total tasks will be rejected by the system. That floor is a safety net — aim for a natural decomposition, not the minimum.',
    '',
    'First call register_plan_outline once with the complete success-criteria-oriented task tree.',
    'Then call register_task_context for every locked task and call finalize_plan with no arguments.',
    'Each milestone, slice, and task needs a detailed successCriteria string (observable outcomes, key files, completion signals).',
    'Use update_task_context to revise an already registered task context before finalize_plan when needed.',
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
