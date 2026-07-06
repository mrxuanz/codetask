<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import {
  fetchConversationCores,
  fetchThreadMessages,
  type ConversationMessage
} from '@renderer/api/conversation'
import { fetchJob, fetchThreadPlans, type ThreadJob } from '@renderer/api/jobs'
import TaskLaunchDraftCard from '@renderer/components/home/TaskLaunchDraftCard.vue'
import PlanReviewAccordion from '@renderer/components/tasks/PlanReviewAccordion.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { buildPlanTree } from '@renderer/lib/jobProgress'
import { cn } from '@renderer/lib/utils'

const props = defineProps<{
  threadId: string
  draftMessageId: string
  jobId: string
  title?: string
}>()

const { t } = useI18n()
const router = useRouter()

const loading = ref(true)
const error = ref<string | null>(null)
const draftMessage = ref<ConversationMessage | null>(null)
const threadMessages = ref<ConversationMessage[]>([])
const plan = ref<ThreadJob | null>(null)
const cores = ref<Awaited<ReturnType<typeof fetchConversationCores>>['data']['cores']>([])
const expanded = ref({ draft: true, plan: true })

const planTree = computed(() => buildPlanTree(plan.value, t))

function toggleSection(section: 'draft' | 'plan'): void {
  expanded.value = { ...expanded.value, [section]: !expanded.value[section] }
}

function goToTask(): void {
  void router.push({ name: 'task-detail', params: { jobId: props.jobId } })
}

onMounted(async () => {
  loading.value = true
  error.value = null
  try {
    const [messagesRes, plansRes, coresRes, jobRes] = await Promise.all([
      fetchThreadMessages(props.threadId, 200),
      fetchThreadPlans(props.threadId),
      fetchConversationCores(),
      fetchJob(props.jobId)
    ])
    threadMessages.value = messagesRes.data.messages
    draftMessage.value =
      messagesRes.data.messages.find((msg) => msg.id === props.draftMessageId) ?? null
    plan.value =
      jobRes.data.job ?? plansRes.data.plans.find((item) => item.id === props.jobId) ?? null
    cores.value = coresRes.data.cores
    if (!draftMessage.value) {
      error.value = t('workspace.create.completedDraftMissing')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
    <div class="flex flex-wrap items-start justify-between gap-4">
      <div class="min-w-0">
        <h1 class="text-lg font-semibold">{{ title || t('workspace.create.completedTitle') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ t('workspace.create.completedHint') }}</p>
      </div>
      <Button type="button" @click="goToTask">
        {{ t('workspace.create.viewTask') }}
      </Button>
    </div>

    <ErrorAlert v-if="error" :message="error" />

    <div
      v-if="loading"
      class="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground"
    >
      <Spinner class="size-5" />
      {{ t('workspace.loading') }}
    </div>

    <div v-else class="space-y-3">
      <section class="rounded-xl border border-border bg-card">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40"
          @click="toggleSection('draft')"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            :class="
              cn(
                'size-3.5 text-muted-foreground transition-transform',
                expanded.draft && 'rotate-90'
              )
            "
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
            {{ t('workspace.create.completedDraftTag') }}
          </span>
        </button>
        <div v-if="expanded.draft && draftMessage" class="border-t border-border px-4 py-4">
          <TaskLaunchDraftCard
            :message="draftMessage"
            :thread-id="threadId"
            :thread-messages="threadMessages"
            :cores="cores"
            embedded
            read-only
          />
        </div>
      </section>

      <section class="rounded-xl border border-border bg-card">
        <button
          type="button"
          class="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-muted/40"
          @click="toggleSection('plan')"
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            :class="
              cn(
                'size-3.5 text-muted-foreground transition-transform',
                expanded.plan && 'rotate-90'
              )
            "
            aria-hidden="true"
          >
            <path d="M6 4l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="rounded-md bg-muted px-2 py-0.5 text-xs font-medium">
            {{ t('workspace.create.completedPlanTag') }}
          </span>
        </button>
        <div v-if="expanded.plan" class="border-t border-border px-4 py-4">
          <PlanReviewAccordion
            :milestones="planTree"
            :abilities="plan?.abilities"
            :review-mode="true"
            :default-expand-all="true"
            :task-cli-editable="false"
            :cores="cores"
          />
        </div>
      </section>
    </div>
  </div>
</template>
