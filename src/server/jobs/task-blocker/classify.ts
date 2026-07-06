import type { TaskEvidencePacket } from './types'
import type { TaskBlockerClassification, TaskBlockerKind } from './types'

const AGENT_BLOCKER_KINDS = new Set<TaskBlockerKind>([
  'infra',
  'dependency-prep',
  'dependency-human',
  'decision',
  'implementation'
])

function corpus(packet: TaskEvidencePacket): string {
  return [
    packet.summary,
    ...(packet.blockers ?? []),
    ...packet.evidence,
    packet.validation.notes ?? ''
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
}

function matchAny(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    if (match) return match[0]
  }
  return null
}

const INFRA_PATTERNS: RegExp[] = [
  /\baborted\b/,
  /error:\s*aborted/,
  /tools?\s*\([^)]*\)\s*(are\s*)?(aborting|failing)/,
  /read,\s*grep,\s*(and\s*)?shell/,
  /no file contents could be retrieved/,
  /could not run any commands/,
  /environment tool failures/,
  /worker\.log/,
  /sandbox\s+(blocked|failed|crashed|error)/,
  /stream disconnected/,
  /sandbox worker exited/,
  /codex exec exited/,
  /sandbox child closed/,
  /internal error/,
  /keepalive/,
  /retriableerror/,
  /econnreset|etimedout|enotfound|eai_again/,
  /socket hang up/,
  /rate limit|429/,
  /unknown exit status/,
  /report_task_result/
]

const HUMAN_DEPENDENCY_PATTERNS: RegExp[] = [
  /api[_ -]?key/,
  /secret[_ -]?key/,
  /credentials?/,
  /not authenticated|authentication required/,
  /agent login/,
  /operator.*(provide|supply|configure)/,
  /permission denied.*(outside|external|host)/,
  /manual\s+intervention/,
  /requires?\s+human/,
  /blocked-by-(allowlist|denylist|policy)/
]

const PREP_DEPENDENCY_PATTERNS: RegExp[] = [
  /(?:file|module|path|directory).*(?:not found|missing|does not exist)/,
  /enoent.*\.(ts|tsx|js|jsx|vue|json|md)/,
  /cannot find module/,
  /missing.*(?:file|module|i18n|key|reference|asset|image|script)/,
  /no such file/,
  /does not export/,
  /key.*not.*defined.*i18n/,
  /spriteextractor.*not found/,
  /(?:env|environment).*(?:script|binary|tool).*(?:missing|not found)/,
  /must be generated first|generate.*before/
]

const IMPLEMENTATION_FAILURE_PATTERNS: RegExp[] = [
  /test(?:s)?\s+(?:failed|failing|error)/,
  /assertion(?:error)?/,
  /expect(?:ed)?.*(?:received|to)/,
  /type\s*error/,
  /lint(?:er)?\s*(?:error|failed)/,
  /compilation\s+failed/,
  /build\s+failed/,
  /validation.*failed/,
  /implementation.*(?:incomplete|incorrect|broken)/,
  /could not implement/,
  /unable to complete.*implementation/
]

function classifyByPatterns(
  text: string,
  status: TaskEvidencePacket['status']
): TaskBlockerClassification {
  const infraHit = matchAny(text, INFRA_PATTERNS)
  if (infraHit) {
    return {
      kind: 'infra',
      source: 'classifier',
      confidence: 'high',
      reasons: [`infra signal: ${infraHit}`]
    }
  }

  const humanHit = matchAny(text, HUMAN_DEPENDENCY_PATTERNS)
  if (humanHit) {
    return {
      kind: 'dependency-human',
      source: 'classifier',
      confidence: 'high',
      reasons: [`human dependency signal: ${humanHit}`]
    }
  }

  const prepHit = matchAny(text, PREP_DEPENDENCY_PATTERNS)
  if (prepHit) {
    return {
      kind: 'dependency-prep',
      source: 'classifier',
      confidence: 'medium',
      reasons: [`automatable dependency signal: ${prepHit}`]
    }
  }

  const implementationHit = matchAny(text, IMPLEMENTATION_FAILURE_PATTERNS)
  if (implementationHit || status === 'failed') {
    return {
      kind: 'implementation',
      source: 'classifier',
      confidence: implementationHit ? 'high' : 'medium',
      reasons: implementationHit
        ? [`implementation failure signal: ${implementationHit}`]
        : ['task reported failed without infra or external dependency signals']
    }
  }

  return {
    kind: 'decision',
    source: 'classifier',
    confidence: 'low',
    reasons: ['blocked without recognizable infra or dependency pattern']
  }
}

function parseAgentBlockerKind(packet: TaskEvidencePacket): TaskBlockerKind | null {
  const raw = packet.blockerKind?.trim()
  if (!raw || !AGENT_BLOCKER_KINDS.has(raw as TaskBlockerKind)) return null
  return raw as TaskBlockerKind
}

function mergeWithAgentHint(
  inferred: TaskBlockerClassification,
  agentKind: TaskBlockerKind | null
): TaskBlockerClassification {
  if (!agentKind) return inferred

  if (inferred.kind === 'infra' && inferred.confidence === 'high') {
    if (agentKind === 'dependency-human' || agentKind === 'dependency-prep') {
      return {
        kind: 'infra',
        source: 'merged',
        confidence: 'high',
        reasons: [...inferred.reasons, `agent reported ${agentKind} but infra signals dominate`]
      }
    }
  }

  if (agentKind === inferred.kind) {
    return {
      ...inferred,
      source: 'merged',
      confidence: inferred.confidence === 'low' ? 'medium' : inferred.confidence,
      reasons: [...inferred.reasons, `agent blockerKind=${agentKind}`]
    }
  }

  if (inferred.confidence === 'low') {
    return {
      kind: agentKind,
      source: 'agent',
      confidence: 'medium',
      reasons: [`agent blockerKind=${agentKind}`, ...inferred.reasons]
    }
  }

  return {
    ...inferred,
    source: 'merged',
    reasons: [...inferred.reasons, `agent blockerKind=${agentKind} (kept classifier kind)`]
  }
}

export function classifyTaskOutcome(packet: TaskEvidencePacket): TaskBlockerClassification {
  const text = corpus(packet)
  const inferred = classifyByPatterns(text, packet.status)
  const agentKind = parseAgentBlockerKind(packet)
  return mergeWithAgentHint(inferred, agentKind)
}
