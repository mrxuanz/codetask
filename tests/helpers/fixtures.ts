import type { SupportedCoreCode } from '../../src/server/conversation/cores'

export const FIXTURE_DRAFT_TITLE = '小型功能'

export const FIXTURE_ABILITIES = [
  {
    abilityCode: 'project-setup',
    reason: '初始化项目结构与配置',
    recommendedCoreCode: 'codex' as SupportedCoreCode
  },
  {
    abilityCode: 'frontend-implementation',
    reason: '实现前端界面与交互',
    recommendedCoreCode: 'cursorcli' as SupportedCoreCode
  },
  {
    abilityCode: 'testing-validation',
    reason: '运行验证并整理证据',
    recommendedCoreCode: 'claude-code' as SupportedCoreCode
  }
]

export function buildProposeTaskDraftArgs(): {
  title: string
  summary: string
  userFlow: string
  techStack: string
  abilities: typeof FIXTURE_ABILITIES
  acceptance: { id: string; given: string; when: string; then: string }[]
  verification: { command: string; appliesTo: string }[]
  nfr: string[]
  outOfScope: string[]
  assumptions: string[]
} {
  return {
    title: FIXTURE_DRAFT_TITLE,
    summary: '在临时工作区实现一个可演示的小型功能。',
    userFlow: '用户打开页面并完成核心操作。',
    techStack: 'TypeScript + 轻量前端',
    abilities: FIXTURE_ABILITIES,
    acceptance: [
      {
        id: 'ac-1',
        given: '工作区已初始化',
        when: '用户执行核心流程',
        then: '功能可用且无阻塞错误'
      }
    ],
    verification: [{ command: 'npm run typecheck', appliesTo: 'all' }],
    nfr: ['可维护'],
    outOfScope: ['生产部署'],
    assumptions: ['使用临时 workspace']
  }
}

export const FIXTURE_TASK_CONTEXTS = [
  {
    milestone: 1,
    slice: 1,
    task: 1,
    taskTitle: '项目初始化',
    content: '## Setup\n创建基础目录与配置文件。'
  },
  {
    milestone: 1,
    slice: 2,
    task: 1,
    taskTitle: '前端实现',
    content: '## Implementation\n实现页面与交互逻辑。'
  },
  {
    milestone: 1,
    slice: 2,
    task: 2,
    taskTitle: '验证',
    content: '## Validation\n运行检查并记录证据。'
  }
] as const

export function buildPlanOutlineArgs(referenceIds: string[] = []): {
  milestones: {
    title: string
    description: string
    successCriteria: string
    slices: {
      title: string
      description: string
      successCriteria: string
      dependsOnSliceRefs: string[]
      tasks: {
        title: string
        description: string
        taskKind: string
        abilityCode: string
        referenceIds?: string[]
        referenceReason?: string
        successCriteria: string
      }[]
    }[]
  }[]
} {
  return {
    milestones: [
      {
        title: 'Milestone 1',
        description: '交付小型功能',
        successCriteria: '核心功能可演示且验证通过',
        slices: [
          {
            title: 'Setup slice',
            description: '初始化工作区',
            successCriteria: '基础结构与配置就绪',
            dependsOnSliceRefs: [],
            tasks: [
              {
                title: '项目初始化',
                description: '创建项目骨架与基础配置',
                taskKind: 'project-setup',
                abilityCode: 'project-setup',
                successCriteria: '工作区包含可运行骨架'
              }
            ]
          },
          {
            title: 'Implementation slice',
            description: '实现与验证',
            successCriteria: '实现完成且验证通过',
            dependsOnSliceRefs: ['m1-s1'],
            tasks: [
              {
                title: '前端实现',
                description: '实现用户界面',
                taskKind: 'frontend-implementation',
                abilityCode: 'frontend-implementation',
                referenceIds,
                referenceReason: referenceIds.length > 0 ? '实现需参考附件' : undefined,
                successCriteria: '页面可交互'
              },
              {
                title: '验证',
                description: '运行验证命令',
                taskKind: 'testing-validation',
                abilityCode: 'testing-validation',
                successCriteria: '验证命令通过'
              }
            ]
          }
        ]
      }
    ]
  }
}

export const FIXTURE_TASK_EVIDENCE = {
  status: 'completed' as const,
  summary: 'Task completed with evidence',
  changedFiles: ['src/demo.ts'],
  evidence: ['src/demo.ts exports runDemo()'],
  validation: { ran: true, outcome: 'passed' as const, notes: 'typecheck ok' }
}

export const FIXTURE_SLICE_VERDICT_PASSED = {
  status: 'progress-ok',
  confidence: 'high',
  summary: 'Slice verification passed',
  satisfiedSignals: ['tasks completed'],
  missingSignals: [],
  questionableClaims: [],
  evidenceTrace: [{ requirement: 'slice complete', status: 'met' }],
  repairSuggestions: []
}

export const FIXTURE_SLICE_VERDICT_NEEDS_REPAIR = {
  status: 'needs-repair',
  confidence: 'medium',
  summary: 'Implementation incomplete',
  satisfiedSignals: [],
  missingSignals: ['UI wiring'],
  questionableClaims: [],
  evidenceTrace: [],
  repairSuggestions: [
    {
      reason: 'Missing UI wiring',
      instruction: 'Wire the form submit handler',
      targetTaskId: 'm1-s2-t1'
    }
  ]
}

export const FIXTURE_SLICE_VERDICT_INCONCLUSIVE = {
  status: 'inconclusive',
  confidence: 'low',
  summary: 'Evidence insufficient',
  satisfiedSignals: [],
  missingSignals: ['validation log'],
  questionableClaims: [],
  evidenceTrace: [],
  repairSuggestions: []
}

export const FIXTURE_MILESTONE_VERDICT_PASSED = {
  status: 'passed',
  confidence: 'high',
  summary: 'Milestone passed',
  requirementTrace: [{ requirement: 'milestone complete', status: 'met' }],
  sliceAssessments: [{ sliceId: 'm1-s1', status: 'ok', reason: 'done' }],
  repairTasks: []
}
