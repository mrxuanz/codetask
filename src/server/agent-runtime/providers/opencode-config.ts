import type { Config, QuestionAnswer } from '@opencode-ai/sdk/v2'
import { capabilityProfileIsReadOnly, type AgentCapabilityProfile } from '../capabilities'
import { allCreateTaskMcpToolNames } from '../../wizard/tools'
import { PLANNER_ROLE_MCP_TOOLS } from '../roles'

const READ_ONLY_SYSTEM_MCP_TOOLS = new Set<string>([
  'codeteam-manager',
  ...allCreateTaskMcpToolNames(),
  ...PLANNER_ROLE_MCP_TOOLS
])

/**
 * OpenCode interactive `question` handling for CodeTask.
 *
 * Background
 * ----------
 * CodeTask is a non-interactive host: conversation and task turns have no
 * question UI (unlike T3Code's `user-input.requested` panel). When a model
 * calls OpenCode's `question` tool, the session waits for `Question.reply()`
 * that never arrives → hang → renderer `SSE stream idle timeout` (~45s) or a
 * stalled task turn. DeepSeek-class models trigger this often; quieter models
 * (e.g. MiMo) may not.
 *
 * Upstream
 * --------
 * - Issue: https://github.com/anomalyco/opencode/issues/11899
 *   (`opencode run` hangs when the model uses the question tool)
 * - Proposed fix PR (NOT merged as of 2026-05; auto-closed for inactivity):
 *   https://github.com/anomalyco/opencode/pull/14607
 * - Related: session/config `question: deny` / `tools.question: false` often
 *   never reach tool filtering (agent-level `question: allow` + Question.ask()
 *   bypassing ctx.ask()). Observed still on OpenCode 1.17.18.
 * - Pitfall: a blanket `"*": "allow"` can re-enable question depending on
 *   rule order (last match wins); keep an explicit `question: "deny"` after
 *   any wildcard allow. See also https://github.com/anomalyco/opencode/issues/13827
 *
 * CodeTask policy
 * ---------------
 * Prefer autonomous execution over asking the user:
 * 1. Still publish deny / tools:false (best-effort filter when the CLI honors it).
 * 2. If `question.asked` still fires, auto-`question.reply` with the recommended
 *    (first) option — same spirit as Cursor ACP `autoAnswerCursorAskQuestion`
 *    and as #14607's "Make your best judgment and proceed". Never `reject`:
 *    reject aborts the turn mid-reply (partial assistant text, then cleanup).
 * Task workers cannot wait for a human text answer; auto-reply is required.
 */

/** Guidance used when a question has no options (or allows custom answers). */
export const OPENCODE_AUTO_QUESTION_GUIDANCE =
  'Make your best judgment and proceed without waiting for the user. Prefer concrete action over more questions.'

/**
 * Prefer an explicit question deny after wildcard allow (last matching rule wins).
 * Do not rely on this alone — OpenCode may still emit `question.asked`.
 */
export function resolveOpencodePermissionConfig(
  capabilityProfile?: AgentCapabilityProfile
): NonNullable<Config['permission']> {
  if (!capabilityProfile || !capabilityProfileIsReadOnly(capabilityProfile)) {
    return {
      '*': 'allow',
      question: 'deny'
    }
  }

  const auditedMcpRules = Object.fromEntries(
    [...READ_ONLY_SYSTEM_MCP_TOOLS]
      .filter((toolName) => toolName !== 'codeteam-manager')
      .flatMap((toolName) => [
        [toolName, 'allow' as const],
        [`codeteam-manager_${toolName}`, 'allow' as const],
        [`mcp__codeteam-manager__${toolName}`, 'allow' as const]
      ])
  )
  return {
    '*': 'deny',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    lsp: 'allow',
    ...auditedMcpRules,
    question: 'deny'
  }
}

/** Best-effort tool disable; still pair with auto-reply on `question.asked`. */
export function resolveOpencodeToolsConfig(
  capabilityProfile?: AgentCapabilityProfile
): NonNullable<Config['tools']> {
  const readOnly = capabilityProfile !== undefined && capabilityProfileIsReadOnly(capabilityProfile)
  return readOnly
    ? {
        read: true,
        glob: true,
        grep: true,
        list: true,
        lsp: true,
        question: false,
        bash: false,
        edit: false,
        write: false,
        patch: false,
        task: false,
        skill: false
      }
    : { question: false }
}

export interface OpencodeQuestionOptionDto {
  readonly label: string
  readonly description: string
}

export interface OpencodeQuestionDto {
  readonly options: readonly OpencodeQuestionOptionDto[]
  readonly multiple: boolean
  readonly custom: boolean
}

function parseQuestionOption(value: unknown): OpencodeQuestionOptionDto | null {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const row = value as Record<string, unknown>
  if (row.label !== undefined && typeof row.label !== 'string') {
    return null
  }
  if (row.description !== undefined && typeof row.description !== 'string') {
    return null
  }
  return {
    label: typeof row.label === 'string' ? row.label : '',
    description: typeof row.description === 'string' ? row.description : ''
  }
}

function parseOpencodeQuestion(value: unknown): OpencodeQuestionDto {
  if (typeof value !== 'object' || value === null) {
    return { options: [], multiple: false, custom: false }
  }
  const row = value as Record<string, unknown>
  const options = Array.isArray(row.options)
    ? row.options
        .map(parseQuestionOption)
        .filter((option): option is OpencodeQuestionOptionDto => option !== null)
    : []
  return {
    options,
    multiple: row.multiple === true,
    custom: row.custom === true
  }
}

/** Normalize provider question payloads before auto-reply. */
export function parseOpencodeQuestions(value: unknown): ReadonlyArray<OpencodeQuestionDto> {
  if (!Array.isArray(value)) {
    return []
  }
  return value.map(parseOpencodeQuestion)
}

/**
 * Build OpenCode `question.reply` answers: pick the first (recommended) option
 * label when present; otherwise send guidance text so the agent loop continues.
 */
export function buildOpencodeAutoQuestionAnswers(
  questions: ReadonlyArray<OpencodeQuestionDto>
): Array<QuestionAnswer> {
  return questions.map((question) => {
    const first = question.options?.[0]
    if (first?.label?.trim()) {
      return question.multiple ? [first.label] : [first.label]
    }
    return [OPENCODE_AUTO_QUESTION_GUIDANCE]
  })
}
