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
  fetchJob,
  freezeReferenceCorpus,
  launchDesignSession,
  retryJobPlanning
} from '@renderer/api/jobs'
import type { JobSseEvent } from '@shared/contracts/sse'
import { useJobEventHub } from '@renderer/composables/useJobEventHub'
import { threadTopic } from '@shared/contracts/job-event-hub'
import { resolveDraftPlanReference } from '@shared/draft-plan-resolve'
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
  /** False until the first loadWorkspace for the current thread finishes (success or error). */
  workspaceReady: Ref<boolean>
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
  const workspaceReady = ref(false)
  const error = ref<string | null>(null)
  const successMessage = ref<string | null>(null)
  const selectedDraftId = ref<string | null>(null)
  const centerView = ref<CenterView>('draft')
  const currentStep = ref(0)
  const confirmingPlan = ref(false)
  const freezingCorpus = ref(false)
  const retryingPlan = ref(false)
  let loadToken = 0
  let planHubRelease: (() => void) | null = null
  let threadHubRelease: (() => void) | null = null
  let watchedPlanJobId: string | null = null
  const jobHub = useJobEventHub()

  function stopPlanStream(): void {
    planHubRelease?.()
    planHubRelease = null
    watchedPlanJobId = null
  }

  function stopThreadWatch(): void {
    threadHubRelease?.()
    threadHubRelease = null
  }

  function watchThread(threadId: string): void {
    stopThreadWatch()
    threadHubRelease = jobHub.watchTopic(threadTopic(threadId), (envelope) => {
      if (options.threadId.value !== threadId) return
      if (envelope.event === 'draft_updated') {
        void onDraftUpdated(envelope.data.message)
      }
    })
  }

  const draftMessages = computed(() =>
    options.messages.value.filter((msg) => msg.kind === 'task-launch-draft')
  )

  const selectedMessage = computed(
    () => draftMessages.value.find((msg) => msg.id === selectedDraftId.value) ?? null
  )

  function draftPlanRefs(
    draft: ThreadDraftSummaryDto,
    payload?: TaskLaunchDraftPayload | null
  ): ReturnType<typeof resolveDraftPlanReference> {
    return resolveDraftPlanReference({
      linkedPlanId: draft.linkedPlanId,
      designSessionId:
        draft.designSessionId ??
        (payload as { designSessionId?: string | null } | null | undefined)?.designSessionId,
      launchedJobId: draft.launchedJobId,
      planId: draft.plan?.id,
      planStatus: draft.plan?.status,
      planConfirmedAt: (draft.plan as { planConfirmedAt?: number | null } | null | undefined)
        ?.planConfirmedAt
    })
  }

  function findPlanForDraft(
    draft: ThreadDraftSummaryDto,
    payload?: TaskLaunchDraftPayload | null
  ): ThreadJobDto | null {
    const refs = draftPlanRefs(draft, payload)
    if (refs.activePlanId) {
      const byId = plans.value.find((plan) => plan.id === refs.activePlanId)
      if (byId) return byId
    }
    if (refs.launchedJobId) {
      const byJob = plans.value.find((plan) => plan.id === refs.launchedJobId)
      if (byJob) return byJob
    }
    return null
  }

  const selectedPlan = computed(() => {
    const draft = drafts.value.find((d) => d.messageId === selectedDraftId.value)
    if (!draft) return null
    return findPlanForDraft(draft, payloadForSelected())
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
    return Boolean(draftPlanRefs(draft).activePlanId)
  }

  async function mergeLaunchedThreadJobs(): Promise<void> {
    const launchedJobIds = [
      ...new Set(
        drafts.value
          .map((draft) => draftPlanRefs(draft).launchedJobId)
          .filter((id): id is string => Boolean(id))
      )
    ]
    if (launchedJobIds.length === 0) return

    const fetched = await Promise.all(
      launchedJobIds.map(async (jobId) => {
        try {
          const res = await fetchJob(jobId)
          return res.data.job
        } catch {
          return null
        }
      })
    )

    for (const job of fetched) {
      if (!job) continue
      const idx = plans.value.findIndex((plan) => plan.id === job.id)
      if (idx >= 0) plans.value[idx] = job
      else plans.value.push(job)
    }
  }

  function isDraftSelected(messageId: string): boolean {
    return selectedDraftId.value === messageId
  }

  function resolveDraftStepForDraft(draft: ThreadDraftSummaryDto): number {
    const message = draftMessages.value.find((m) => m.id === draft.messageId)
    const payload = (message?.payload ?? {}) as TaskLaunchDraftPayload
    const plan = findPlanForDraft(draft, payload) ?? draft.plan
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
    if (!threadId) {
      workspaceReady.value = false
      return
    }
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
      await mergeLaunchedThreadJobs()
      if (token !== loadToken || options.threadId.value !== threadId) return

      const initialId = options.initialDraftId?.value
      if (initialId && drafts.value.some((d) => d.messageId === initialId)) {
        selectedDraftId.value = initialId
        const draft = drafts.value.find((d) => d.messageId === initialId)
        void updateThreadContext(threadId, {
          activeDraftId: initialId,
          activePlanId: draft ? draftPlanRefs(draft).activePlanId : null
        })
      }
      if (selectedDraftId.value) {
        syncStepFromState()
        const draft = drafts.value.find((d) => d.messageId === selectedDraftId.value)
        const activePlanId = draft ? draftPlanRefs(draft, payloadForSelected()).activePlanId : null
        if (activePlanId) void watchPlan(activePlanId)
      }
    } catch (err) {
      if (token !== loadToken) return
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      if (token === loadToken) {
        loading.value = false
        workspaceReady.value = true
      }
    }
  }

  async function refreshPlansAfterWatch(threadId: string): Promise<void> {
    const planRes = await fetchThreadPlans(threadId)
    plans.value = planRes.data.plans
    await mergeLaunchedThreadJobs()
    syncStepFromState()
  }

  function applyPlanHubEvent(jobId: string, event: JobSseEvent, threadId: string): void {
    if (options.threadId.value !== threadId) return
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
  }

  function watchPlan(jobId: string): void {
    const threadId = options.threadId.value
    if (!threadId) return
    stopPlanStream()
    watchedPlanJobId = jobId
    planHubRelease = jobHub.watchJob(jobId, (event) => {
      applyPlanHubEvent(jobId, event, threadId)
      if (event.event === 'job_done') {
        void refreshPlansAfterWatch(threadId)
        if (watchedPlanJobId === jobId) stopPlanStream()
      }
    })
  }

  async function selectDraft(messageId: string): Promise<void> {
    const threadId = options.threadId.value
    if (!threadId) return
    const draft = drafts.value.find((d) => d.messageId === messageId)
    if (!draft) return

    selectedDraftId.value = messageId
    successMessage.value = null
    const refs = draftPlanRefs(draft)
    await updateThreadContext(threadId, {
      activeDraftId: messageId,
      activePlanId: refs.activePlanId
    })
    if (options.threadId.value !== threadId) return
    syncStepFromState()
    if (refs.activePlanId) void watchPlan(refs.activePlanId)
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
      stopPlanStream()
      setStep(1)
      return
    }
    const draft = drafts.value.find((d) => d.messageId === message.id)
    const activePlanId = draft
      ? draftPlanRefs(draft, payload).activePlanId
      : (payload.linkedPlanId ?? null)
    if (activePlanId) void watchPlan(activePlanId)
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
    if (!plan || !threadId) return
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
    (threadId) => {
      stopPlanStream()
      stopThreadWatch()
      selectedDraftId.value = null
      currentStep.value = 0
      centerView.value = 'draft'
      successMessage.value = null
      workspaceReady.value = false
      if (threadId) watchThread(threadId)
      void loadWorkspace()
    },
    { immediate: true }
  )

  onScopeDispose(() => {
    stopPlanStream()
    stopThreadWatch()
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
    workspaceReady,
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
