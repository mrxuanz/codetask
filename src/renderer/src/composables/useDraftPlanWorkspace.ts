import {
  computed,
  inject,
  onScopeDispose,
  provide,
  ref,
  watch,
  type InjectionKey,
  type Ref
} from 'vue'
import type { ConversationMessageDto } from '@shared/contracts/conversation'
import type { ThreadDraftSummaryDto, ThreadJobDto } from '@shared/contracts/jobs'
import {
  fetchThreadDrafts,
  fetchThreadPlans,
  freezeReferenceCorpus,
  launchDesignSession,
  retryJobPlanning,
  streamThreadJob
} from '@renderer/api/jobs'
import { isDesignSessionId } from '@shared/design-session'
import { updateThreadContext } from '@renderer/api/threads'
import {
  DRAFT_WIZARD_STEP_COUNT,
  isDraftStepComplete,
  resolveDraftStep,
  type TaskLaunchDraftPayload
} from '@renderer/lib/draftForm'
import { buildPlanTree } from '@renderer/lib/jobProgress'
import type { TranslateFn } from '@renderer/lib/jobProgress'

export type CenterView = 'draft' | 'plan'

export interface DraftPlanWorkspaceContext {
  drafts: Ref<ThreadDraftSummaryDto[]>
  plans: Ref<ThreadJobDto[]>
  loading: Ref<boolean>
  error: Ref<string | null>
  successMessage: Ref<string | null>
  selectedDraftId: Ref<string | null>
  centerView: Ref<CenterView>
  currentStep: Ref<number>
  selectedMessage: Ref<ConversationMessageDto | null>
  selectedPlan: Ref<ThreadJobDto | null>
  planTree: Ref<ReturnType<typeof buildPlanTree>>
  showPlanEditor: Ref<boolean>
  confirmingPlan: Ref<boolean>
  freezingCorpus: Ref<boolean>
  retryingPlan: Ref<boolean>
  loadWorkspace: () => Promise<void>
  selectDraft: (messageId: string) => Promise<void>
  onDraftCreated: (messageId: string) => Promise<void>
  onDraftUpdated: (message: ConversationMessageDto) => void
  handlePlanStarted: (jobId: string) => Promise<void>
  handleConfirmPlan: () => Promise<void>
  handleRefreezeCorpus: () => Promise<void>
  handleRetryPlanning: () => Promise<void>
  refreshPlan: () => Promise<void>
  stopPlanStream: () => void
  setStep: (step: number) => void
  goNextStep: () => void
  goPrevStep: () => void
  resolveDraftStepForDraft: (draft: ThreadDraftSummaryDto) => number
  draftHasPlan: (draft: ThreadDraftSummaryDto) => boolean
  isDraftSelected: (messageId: string) => boolean
  isStepComplete: (step: number) => boolean
  stepCount: number
}

const DraftPlanWorkspaceKey: InjectionKey<DraftPlanWorkspaceContext> = Symbol('draftPlanWorkspace')

export function provideDraftPlanWorkspace(options: {
  threadId: Ref<string | null>
  messages: Ref<ConversationMessageDto[]>
  initialDraftId?: Ref<string | null | undefined>
  t: TranslateFn
}): DraftPlanWorkspaceContext {
  const drafts = ref<ThreadDraftSummaryDto[]>([])
  const plans = ref<ThreadJobDto[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)
  const selectedDraftId = ref<string | null>(null)
  const centerView = ref<CenterView>('draft')
  const currentStep = ref(0)
  const confirmingPlan = ref(false)
  const freezingCorpus = ref(false)
  const retryingPlan = ref(false)
  let streamToken = 0
  let loadToken = 0
  let planStreamAbort: AbortController | null = null

  function stopPlanStream(): void {
    planStreamAbort?.abort()
    planStreamAbort = null
    streamToken += 1
  }

  const draftMessages = computed(() =>
    options.messages.value.filter((msg) => msg.kind === 'task-launch-draft')
  )

  const selectedMessage = computed(
    () => draftMessages.value.find((msg) => msg.id === selectedDraftId.value) ?? null
  )

  const selectedPlan = computed(() => {
    const draft = drafts.value.find((d) => d.messageId === selectedDraftId.value)
    const planId = draft?.linkedPlanId ?? draft?.plan?.id
    if (!planId) return null
    return plans.value.find((p) => p.id === planId) ?? null
  })

  const planTree = computed(() => buildPlanTree(selectedPlan.value, options.t))

  const showPlanEditor = computed(() =>
    Boolean(selectedPlan.value && ['planning', 'plan_editing'].includes(selectedPlan.value.status))
  )

  function payloadForSelected(): TaskLaunchDraftPayload | null {
    if (!selectedMessage.value?.payload) return null
    return selectedMessage.value.payload as TaskLaunchDraftPayload
  }

  function draftHasPlan(draft: ThreadDraftSummaryDto): boolean {
    return Boolean(draft.linkedPlanId)
  }

  function isDraftSelected(messageId: string): boolean {
    return selectedDraftId.value === messageId
  }

  function resolveDraftStepForDraft(draft: ThreadDraftSummaryDto): number {
    const message = draftMessages.value.find((m) => m.id === draft.messageId)
    const payload = (message?.payload ?? {}) as TaskLaunchDraftPayload
    const planId = draft.linkedPlanId
    const plan = planId ? (plans.value.find((p) => p.id === planId) ?? draft.plan) : null
    return resolveDraftStep(payload, plan as { status: string } | null)
  }

  function isStepComplete(step: number): boolean {
    return isDraftStepComplete(step, payloadForSelected(), selectedPlan.value)
  }

  function syncStepFromState(): void {
    const draft = drafts.value.find((d) => d.messageId === selectedDraftId.value)
    if (!draft) {
      currentStep.value = 0
      centerView.value = 'draft'
      return
    }
    const step = resolveDraftStepForDraft(draft)
    currentStep.value = step
    centerView.value = step >= 2 ? 'plan' : 'draft'
  }

  function setStep(step: number): void {
    const clamped = Math.max(0, Math.min(DRAFT_WIZARD_STEP_COUNT - 1, step))
    currentStep.value = clamped
    centerView.value = clamped >= 2 ? 'plan' : 'draft'
  }

  function goNextStep(): void {
    setStep(currentStep.value + 1)
  }

  function goPrevStep(): void {
    setStep(currentStep.value - 1)
  }

  async function loadWorkspace(): Promise<void> {
    const threadId = options.threadId.value
    if (!threadId) return
    const token = ++loadToken
    loading.value = true
    error.value = null
    try {
      const [draftRes, planRes] = await Promise.all([
        fetchThreadDrafts(threadId),
        fetchThreadPlans(threadId)
      ])
      if (token !== loadToken || options.threadId.value !== threadId) return

      drafts.value = draftRes.data.drafts
      plans.value = planRes.data.plans
      const initialId = options.initialDraftId?.value
      if (initialId && drafts.value.some((d) => d.messageId === initialId)) {
        selectedDraftId.value = initialId
        const draft = drafts.value.find((d) => d.messageId === initialId)
        void updateThreadContext(threadId, {
          activeDraftId: initialId,
          activePlanId: draft?.linkedPlanId ?? draft?.plan?.id ?? null
        })
      }
      if (selectedDraftId.value) {
        syncStepFromState()
        const draft = drafts.value.find((d) => d.messageId === selectedDraftId.value)
        if (draft?.linkedPlanId) void watchPlan(draft.linkedPlanId)
      }
    } catch (err) {
      if (token !== loadToken) return
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (token === loadToken) {
        loading.value = false
      }
    }
  }

  async function watchPlan(jobId: string): Promise<void> {
    const threadId = options.threadId.value
    if (!threadId) return
    planStreamAbort?.abort()
    const abort = new AbortController()
    planStreamAbort = abort
    const token = ++streamToken
    try {
      await streamThreadJob(
        threadId,
        jobId,
        (event) => {
          if (token !== streamToken || options.threadId.value !== threadId) return
          if (event.event === 'job_snapshot' || event.event === 'job_done') {
            const idx = plans.value.findIndex((p) => p.id === jobId)
            if (idx >= 0) plans.value[idx] = event.data.job
            else plans.value.push(event.data.job)
          }
          if (event.event === 'plan_progress' || event.event === 'task_progress') {
            const idx = plans.value.findIndex((p) => p.id === jobId)
            if (idx >= 0) {
              const job = { ...plans.value[idx] }
              if (event.event === 'plan_progress') {
                job.planProgress = event.data.planProgress
                if (event.data.plan) job.plan = event.data.plan
              }
              if (event.event === 'task_progress') job.taskProgress = event.data.taskProgress
              plans.value[idx] = job
            }
          }
          if (
            event.event === 'job_done' &&
            event.data.job.status === 'plan_editing' &&
            selectedDraftId.value
          ) {
            setStep(2)
          }
        },
        { signal: abort.signal }
      )
    } catch {
      // ignore
    }
    if (token === streamToken && options.threadId.value === threadId) {
      const planRes = await fetchThreadPlans(threadId)
      plans.value = planRes.data.plans
      syncStepFromState()
    }
  }

  async function selectDraft(messageId: string): Promise<void> {
    const threadId = options.threadId.value
    if (!threadId) return
    const draft = drafts.value.find((d) => d.messageId === messageId)
    if (!draft) return

    selectedDraftId.value = messageId
    successMessage.value = null
    await updateThreadContext(threadId, {
      activeDraftId: messageId,
      activePlanId: draft.linkedPlanId ?? draft.plan?.id ?? null
    })
    if (options.threadId.value !== threadId) return
    syncStepFromState()
    if (draft?.linkedPlanId) void watchPlan(draft.linkedPlanId)
  }

  async function onDraftCreated(messageId: string): Promise<void> {
    await loadWorkspace()
    await selectDraft(messageId)
    setStep(1)
  }

  async function onDraftUpdated(message: ConversationMessageDto): Promise<void> {
    const payload = (message.payload ?? {}) as TaskLaunchDraftPayload
    await loadWorkspace()
    if (payload.status === 'editing' && !payload.linkedPlanId) {
      planStreamAbort?.abort()
      setStep(1)
      return
    }
    const linked = payload.linkedPlanId
    if (linked) void watchPlan(linked)
    else syncStepFromState()
  }

  async function handlePlanStarted(jobId: string): Promise<void> {
    setStep(2)
    await loadWorkspace()
    void watchPlan(jobId)
  }

  async function handleConfirmPlan(): Promise<void> {
    const plan = selectedPlan.value
    const threadId = options.threadId.value
    if (!plan || !threadId) return
    if (plan.referenceManifestStale) {
      error.value = options.t('workspace.draftPanel.referenceManifestStaleHint')
      return
    }
    if (!isDesignSessionId(plan.id)) {
      error.value = options.t('workspace.draftPanel.launchRequiresDesignSession')
      return
    }
    confirmingPlan.value = true
    error.value = null
    successMessage.value = null
    try {
      await launchDesignSession(threadId, plan.id)
      await loadWorkspace()
      successMessage.value = options.t('workspace.create.queuedSuccess')
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      confirmingPlan.value = false
    }
  }

  async function handleRetryPlanning(): Promise<void> {
    const plan = selectedPlan.value
    const threadId = options.threadId.value
    if (!plan || !threadId) return

    retryingPlan.value = true
    error.value = null
    successMessage.value = null
    try {
      const res = await retryJobPlanning(plan.id)
      const idx = plans.value.findIndex((item) => item.id === plan.id)
      if (idx >= 0) plans.value[idx] = res.data.job
      else plans.value.push(res.data.job)
      setStep(2)
      void watchPlan(plan.id)
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      retryingPlan.value = false
    }
  }

  async function refreshPlan(): Promise<void> {
    const planId = selectedPlan.value?.id
    await loadWorkspace()
    if (planId) void watchPlan(planId)
  }

  async function handleRefreezeCorpus(): Promise<void> {
    const plan = selectedPlan.value
    const threadId = options.threadId.value
    if (!plan || !threadId || !isDesignSessionId(plan.id)) return
    freezingCorpus.value = true
    error.value = null
    successMessage.value = null
    try {
      await freezeReferenceCorpus(threadId, plan.id)
      await refreshPlan()
      successMessage.value = options.t('workspace.draftPanel.refreezeSuccess')
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      freezingCorpus.value = false
    }
  }

  watch(
    () => options.threadId.value,
    () => {
      stopPlanStream()
      selectedDraftId.value = null
      currentStep.value = 0
      centerView.value = 'draft'
      successMessage.value = null
      void loadWorkspace()
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    stopPlanStream()
  })

  watch(
    () => [selectedMessage.value?.payload, selectedPlan.value?.status] as const,
    () => {
      if (selectedDraftId.value) syncStepFromState()
    }
  )

  const ctx: DraftPlanWorkspaceContext = {
    drafts,
    plans,
    loading,
    error,
    successMessage,
    selectedDraftId,
    centerView,
    currentStep,
    selectedMessage,
    selectedPlan,
    planTree,
    showPlanEditor,
    confirmingPlan,
    freezingCorpus,
    retryingPlan,
    loadWorkspace,
    selectDraft,
    onDraftCreated,
    onDraftUpdated,
    handlePlanStarted,
    handleConfirmPlan,
    handleRefreezeCorpus,
    handleRetryPlanning,
    refreshPlan,
    stopPlanStream,
    setStep,
    goNextStep,
    goPrevStep,
    resolveDraftStepForDraft,
    draftHasPlan,
    isDraftSelected,
    isStepComplete,
    stepCount: DRAFT_WIZARD_STEP_COUNT
  }

  provide(DraftPlanWorkspaceKey, ctx)
  return ctx
}

export function useDraftPlanWorkspace(): DraftPlanWorkspaceContext {
  const ctx = inject(DraftPlanWorkspaceKey)
  if (!ctx) throw new Error('useDraftPlanWorkspace must be used within provideDraftPlanWorkspace')
  return ctx
}
