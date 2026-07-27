<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import {
  CheckCircle2,
  ChevronRight,
  FilePlus2,
  Loader2,
  MessageSquareText,
  Paperclip,
  Plus,
  Send,
  Sparkles,
  Trash2,
  X
} from 'lucide-vue-next'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import ExecutionTreeView from '@renderer/components/draft/ExecutionTreeView.vue'
import { useHomeWorkspace } from '@renderer/composables/useHomeWorkspace'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { useI18n } from 'vue-i18n'
import {
  confirmDraftExecutionTree,
  deleteDraft,
  fetchDraft,
  fetchDrafts,
  removeDraftAttachment,
  startPlannerSession,
  streamDraftGeneration,
  streamPlannerTurn,
  uploadDraftAttachment,
  type DraftDetails,
  type DraftRecord
} from '@renderer/api/drafts'
import {
  fetchConversationMessages,
  fetchConversationThread,
  updateConversationThread,
  type ConversationMessage,
  type ConversationThread
} from '@renderer/api/conversation'
import type { SupportedCoreCode } from '@shared/providers/codes'

const { t } = useI18n()
const router = useRouter()
const home = useHomeWorkspace()

const drafts = ref<DraftRecord[]>([])
const selectedId = ref<string | null>(null)
const details = ref<DraftDetails | null>(null)
const plannerThread = ref<ConversationThread | null>(null)
const messages = ref<ConversationMessage[]>([])
const loading = ref(true)
const detailsLoading = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)
const composer = ref('')
const showNew = ref(false)
const newWorkspaceId = ref('')
const newProvider = ref<SupportedCoreCode>('codex')
const newGoal = ref('')
const creating = ref(false)
const busyDraftIds = ref<Set<string>>(new Set())
const progressByDraft = ref<Record<string, number>>({})
const thinkingByDraft = ref<Record<string, string>>({})
const uploading = ref(false)
const generating = ref(false)
const confirming = ref(false)
const rightTab = ref<'draft' | 'tree'>('draft')

const selectedBusy = computed(
  () => selectedId.value !== null && busyDraftIds.value.has(selectedId.value)
)
const providerStatus = computed(() =>
  home.providers.value.find((provider) => provider.code === plannerThread.value?.provider)
)
const canGenerate = computed(
  () =>
    details.value?.draft.plannerPhase === 'ready' &&
    details.value.draft.status !== 'submitted' &&
    !selectedBusy.value &&
    !generating.value
)

function reportError(cause: unknown): void {
  error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
}

function workspaceName(workspaceId: string): string {
  return home.workspaces.value.find((workspace) => workspace.id === workspaceId)?.title ?? workspaceId
}

function setBusy(draftId: string, value: boolean): void {
  const next = new Set(busyDraftIds.value)
  if (value) next.add(draftId)
  else next.delete(draftId)
  busyDraftIds.value = next
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

async function loadDraftList(preferredId?: string): Promise<void> {
  drafts.value = (await fetchDrafts()).data
  const target =
    drafts.value.find((draft) => draft.id === preferredId) ??
    drafts.value.find((draft) => draft.id === selectedId.value) ??
    drafts.value[0]
  if (target) await selectDraft(target.id)
  else {
    selectedId.value = null
    details.value = null
    plannerThread.value = null
    messages.value = []
  }
}

async function selectDraft(id: string): Promise<void> {
  selectedId.value = id
  detailsLoading.value = true
  error.value = null
  success.value = null
  try {
    const nextDetails = (await fetchDraft(id)).data
    const threadId = nextDetails.draft.sourceThreadId
    const [threadResult, messageResult] = threadId
      ? await Promise.all([
          fetchConversationThread(threadId),
          fetchConversationMessages(threadId)
        ])
      : [null, null]
    if (selectedId.value !== id) return
    details.value = nextDetails
    plannerThread.value = threadResult?.data ?? null
    messages.value = messageResult?.data ?? []
    rightTab.value = nextDetails.executionTree ? 'tree' : 'draft'
  } catch (cause) {
    if (selectedId.value === id) reportError(cause)
  } finally {
    if (selectedId.value === id) detailsLoading.value = false
  }
}

function openNew(): void {
  newWorkspaceId.value =
    home.selectedWorkspaceId.value ?? home.workspaces.value[0]?.id ?? ''
  newProvider.value =
    home.providers.value.find((provider) => provider.authenticated)?.code ?? 'codex'
  newGoal.value = ''
  error.value = null
  showNew.value = true
}

async function runPlannerTurn(draftId: string, prompt: string): Promise<void> {
  setBusy(draftId, true)
  progressByDraft.value = { ...progressByDraft.value, [draftId]: 0 }
  thinkingByDraft.value = { ...thinkingByDraft.value, [draftId]: '' }
  try {
    await streamPlannerTurn(draftId, prompt, (event) => {
      if (event.type === 'thinking') {
        thinkingByDraft.value = {
          ...thinkingByDraft.value,
          [draftId]: (thinkingByDraft.value[draftId] ?? '') + event.content
        }
      }
      if (event.type === 'progress') {
        progressByDraft.value = { ...progressByDraft.value, [draftId]: event.receivedCharacters }
      }
      if (event.type === 'completed' && selectedId.value === draftId) {
        details.value = details.value
          ? { ...details.value, draft: event.draft, executionTree: null }
          : details.value
        messages.value = [
          ...messages.value,
          {
            id: event.messageId,
            threadId: plannerThread.value?.id ?? '',
            role: 'assistant',
            content: event.message,
            sequence: messages.value.length + 1,
            createdAtMs: Date.now()
          }
        ]
        rightTab.value = 'draft'
      }
    })
    drafts.value = (await fetchDrafts()).data
    if (selectedId.value === draftId) await selectDraft(draftId)
  } catch (cause) {
    if (selectedId.value === draftId) {
      reportError(cause)
      const threadId = plannerThread.value?.id
      if (threadId) {
        messages.value = (await fetchConversationMessages(threadId)).data
      }
    }
  } finally {
    setBusy(draftId, false)
  }
}

async function createPlanner(): Promise<void> {
  const goal = newGoal.value.trim()
  if (!newWorkspaceId.value || !goal) return
  creating.value = true
  error.value = null
  try {
    const result = (
      await startPlannerSession({
        workspaceId: newWorkspaceId.value,
        provider: newProvider.value,
        initialPrompt: goal
      })
    ).data
    drafts.value = [result.draft, ...drafts.value]
    selectedId.value = result.draft.id
    details.value = {
      draft: result.draft,
      attachments: [],
      executionTree: null,
      handoff: null
    }
    plannerThread.value = result.thread
    messages.value = [
      {
        id: `optimistic-${Date.now()}`,
        threadId: result.thread.id,
        role: 'user',
        content: goal,
        sequence: 1,
        createdAtMs: Date.now()
      }
    ]
    showNew.value = false
    newGoal.value = ''
    void runPlannerTurn(result.draft.id, goal)
  } catch (cause) {
    reportError(cause)
  } finally {
    creating.value = false
  }
}

async function sendMessage(): Promise<void> {
  const draftId = selectedId.value
  const prompt = composer.value.trim()
  const thread = plannerThread.value
  if (!draftId || !prompt || !thread || selectedBusy.value) return
  composer.value = ''
  messages.value = [
    ...messages.value,
    {
      id: `optimistic-${Date.now()}`,
      threadId: thread.id,
      role: 'user',
      content: prompt,
      sequence: messages.value.length + 1,
      createdAtMs: Date.now()
    }
  ]
  await runPlannerTurn(draftId, prompt)
}

async function switchProvider(event: Event): Promise<void> {
  const thread = plannerThread.value
  if (!thread || selectedBusy.value) return
  const provider = (event.target as HTMLSelectElement).value as SupportedCoreCode
  try {
    plannerThread.value = (await updateConversationThread(thread.id, { provider })).data
  } catch (cause) {
    reportError(cause)
  }
}

async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const current = details.value
  input.value = ''
  if (!file || !current || selectedBusy.value) return
  uploading.value = true
  error.value = null
  try {
    await uploadDraftAttachment(current.draft.id, file, current.draft.revision)
    await selectDraft(current.draft.id)
  } catch (cause) {
    reportError(cause)
  } finally {
    uploading.value = false
  }
}

async function removeAttachment(id: string): Promise<void> {
  const current = details.value
  if (!current || selectedBusy.value) return
  try {
    await removeDraftAttachment(current.draft.id, id, current.draft.revision)
    await selectDraft(current.draft.id)
  } catch (cause) {
    reportError(cause)
  }
}

async function generateTree(): Promise<void> {
  const current = details.value
  if (!current || !canGenerate.value) return
  generating.value = true
  error.value = null
  success.value = null
  progressByDraft.value = { ...progressByDraft.value, [current.draft.id]: 0 }
  try {
    await streamDraftGeneration(current.draft.id, (event) => {
      if (event.type === 'thinking') {
        thinkingByDraft.value = {
          ...thinkingByDraft.value,
          [current.draft.id]: (thinkingByDraft.value[current.draft.id] ?? '') + event.content
        }
      }
      if (event.type === 'progress') {
        progressByDraft.value = {
          ...progressByDraft.value,
          [current.draft.id]: event.receivedCharacters
        }
      }
    })
    await loadDraftList(current.draft.id)
    rightTab.value = 'tree'
    success.value = t('drafts.generated')
  } catch (cause) {
    reportError(cause)
    await selectDraft(current.draft.id).catch(() => undefined)
  } finally {
    generating.value = false
  }
}

async function confirmTree(): Promise<void> {
  const current = details.value
  if (!current?.executionTree || !window.confirm(t('drafts.confirmPrompt'))) return
  confirming.value = true
  error.value = null
  try {
    const result = await confirmDraftExecutionTree(
      current.draft.id,
      current.draft.revision,
      current.executionTree.id
    )
    await loadDraftList(current.draft.id)
    await router.push(`/home/tasks/${result.data.job.id}`)
  } catch (cause) {
    reportError(cause)
  } finally {
    confirming.value = false
  }
}

async function removeCurrent(): Promise<void> {
  const current = details.value
  if (!current || selectedBusy.value) return
  const prompt = current.handoff ? t('drafts.deleteSubmittedPrompt') : t('drafts.deletePrompt')
  if (!window.confirm(prompt)) return
  try {
    await deleteDraft(current.draft.id)
    selectedId.value = null
    details.value = null
    plannerThread.value = null
    messages.value = []
    await loadDraftList()
  } catch (cause) {
    reportError(cause)
  }
}

watch(
  () => home.workspaces.value,
  (workspaces) => {
    if (!newWorkspaceId.value && workspaces[0]) newWorkspaceId.value = workspaces[0].id
  },
  { immediate: true }
)

onMounted(async () => {
  loading.value = true
  try {
    await loadDraftList()
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 bg-background">
    <aside class="flex w-64 shrink-0 flex-col border-r border-border bg-card/50">
      <div class="flex h-14 items-center justify-between border-b border-border px-3">
        <div>
          <h1 class="text-sm font-semibold">{{ t('drafts.title') }}</h1>
          <p class="text-[11px] text-muted-foreground">{{ drafts.length }} 个规划会话</p>
        </div>
        <Button size="sm" class="size-8 px-0" @click="openNew">
          <Plus class="size-4" />
        </Button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <div v-if="loading" class="flex justify-center p-8">
          <Loader2 class="size-5 animate-spin text-muted-foreground" />
        </div>
        <button
          v-for="draft in drafts"
          v-else
          :key="draft.id"
          type="button"
          class="mb-1 w-full rounded-lg border px-3 py-2.5 text-left transition-colors"
          :class="
            selectedId === draft.id
              ? 'border-primary/30 bg-primary/10'
              : 'border-transparent hover:bg-muted'
          "
          @click="selectDraft(draft.id)"
        >
          <div class="flex items-start gap-2">
            <MessageSquareText class="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-medium">{{ draft.title }}</p>
              <p class="mt-1 truncate text-[11px] text-muted-foreground">
                {{ workspaceName(draft.workspaceId) }}
              </p>
            </div>
            <Loader2
              v-if="busyDraftIds.has(draft.id)"
              class="mt-0.5 size-3.5 animate-spin text-primary"
            />
            <CheckCircle2
              v-else-if="draft.plannerPhase === 'ready'"
              class="mt-0.5 size-3.5 text-emerald-500"
            />
          </div>
        </button>
        <div v-if="!loading && drafts.length === 0" class="px-3 py-10 text-center">
          <FilePlus2 class="mx-auto size-8 text-muted-foreground/50" />
          <p class="mt-3 text-sm font-medium">还没有任务草案</p>
          <p class="mt-1 text-xs leading-5 text-muted-foreground">
            从一个不完整想法开始，Planner 会通过对话帮你补齐。
          </p>
          <Button size="sm" class="mt-4" @click="openNew">开始创建</Button>
        </div>
      </div>
    </aside>

    <section v-if="detailsLoading" class="flex flex-1 items-center justify-center">
      <Loader2 class="size-6 animate-spin text-muted-foreground" />
    </section>

    <section
      v-else-if="details && plannerThread"
      class="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(360px,1fr)_minmax(360px,0.9fr)]"
    >
      <div class="flex min-h-0 min-w-0 flex-col border-r border-border">
        <header class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border px-4">
          <div class="min-w-0">
            <h2 class="truncate text-sm font-semibold">{{ details.draft.title }}</h2>
            <p class="truncate text-[11px] text-muted-foreground">
              {{ workspaceName(details.draft.workspaceId) }}
            </p>
          </div>
          <div class="flex items-center gap-2">
            <select
              :value="plannerThread.provider"
              class="h-8 rounded-md border border-border bg-background px-2 text-xs"
              :disabled="selectedBusy || details.draft.status === 'submitted'"
              @change="switchProvider"
            >
              <option
                v-for="provider in home.providers.value"
                :key="provider.code"
                :value="provider.code"
              >
                {{ provider.label }}{{ provider.authenticated ? '' : ' · 需登录' }}
              </option>
            </select>
            <Button size="sm" variant="ghost" class="size-8 px-0" @click="removeCurrent">
              <Trash2 class="size-4" />
            </Button>
          </div>
        </header>

        <div v-if="providerStatus && !providerStatus.authenticated" class="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs">
          {{ providerStatus.label }} 尚未完成宿主登录。请在终端运行
          <code class="rounded bg-background px-1">{{ providerStatus.loginCommand }}</code>
        </div>
        <ErrorAlert v-if="error" class="m-3" :message="error" />
        <div v-if="success" class="m-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
          {{ success }}
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div class="mx-auto max-w-3xl space-y-5">
            <div
              v-for="item in messages"
              :key="item.id"
              class="flex"
              :class="item.role === 'user' ? 'justify-end' : 'justify-start'"
            >
              <div
                class="max-w-[86%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm leading-6"
                :class="
                  item.role === 'user'
                    ? 'rounded-br-md bg-primary text-primary-foreground'
                    : 'rounded-bl-md border border-border bg-card'
                "
              >
                {{ item.content }}
              </div>
            </div>
            <div v-if="selectedBusy" class="flex justify-start">
              <div class="rounded-2xl rounded-bl-md border border-border bg-card px-4 py-3 text-sm">
                <div class="flex items-center gap-2 text-muted-foreground">
                  <Loader2 class="size-4 animate-spin" />
                  Planner 正在梳理需求并更新右侧草案…
                </div>
                <p v-if="progressByDraft[details.draft.id]" class="mt-2 text-xs text-muted-foreground">
                  已接收 {{ progressByDraft[details.draft.id] }} 个字符
                </p>
              </div>
            </div>
          </div>
        </div>

        <footer class="shrink-0 border-t border-border p-4">
          <form class="mx-auto flex max-w-3xl items-end gap-2" @submit.prevent="sendMessage">
            <textarea
              v-model="composer"
              rows="2"
              class="min-h-12 flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              :disabled="selectedBusy || details.draft.status === 'submitted'"
              placeholder="补充信息、回答问题，或要求修改草案与执行树…"
              @keydown.meta.enter.prevent="sendMessage"
              @keydown.ctrl.enter.prevent="sendMessage"
            />
            <Button
              type="submit"
              class="size-11 rounded-xl px-0"
              :disabled="!composer.trim() || selectedBusy || details.draft.status === 'submitted'"
            >
              <Send class="size-4" />
            </Button>
          </form>
          <p class="mx-auto mt-2 max-w-3xl text-[11px] text-muted-foreground">
            对话只读取工作区；生成执行树前必须明确确认需求。Provider 使用宿主 CLI 当前模型。
          </p>
        </footer>
      </div>

      <div class="flex min-h-0 min-w-0 flex-col bg-muted/20">
        <header class="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
          <div class="flex items-center gap-1 rounded-lg bg-muted p-1">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-xs font-medium"
              :class="rightTab === 'draft' ? 'bg-background shadow-sm' : 'text-muted-foreground'"
              @click="rightTab = 'draft'"
            >
              需求草案
            </button>
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-xs font-medium"
              :class="rightTab === 'tree' ? 'bg-background shadow-sm' : 'text-muted-foreground'"
              @click="rightTab = 'tree'"
            >
              执行树
            </button>
          </div>
          <span
            class="rounded-full px-2.5 py-1 text-[11px] font-medium"
            :class="
              details.draft.plannerPhase === 'ready'
                ? 'bg-emerald-500/10 text-emerald-700'
                : 'bg-amber-500/10 text-amber-700'
            "
          >
            {{ details.draft.plannerPhase === 'ready' ? '需求已确认' : '正在补全需求' }}
          </span>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto p-5">
          <div v-if="rightTab === 'draft'" class="space-y-4">
            <section class="rounded-xl border border-border bg-card p-4">
              <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">目标</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ details.draft.objective }}</p>
            </section>
            <section class="rounded-xl border border-border bg-card p-4">
              <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">详细需求</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">{{ details.draft.requirements }}</p>
            </section>
            <section class="rounded-xl border border-border bg-card p-4">
              <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">约束与非目标</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">
                {{ details.draft.constraints || '暂无明确约束' }}
              </p>
            </section>
            <section class="rounded-xl border border-border bg-card p-4">
              <p class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">验收标准</p>
              <p class="mt-2 whitespace-pre-wrap text-sm leading-6">
                {{ details.draft.acceptanceCriteria }}
              </p>
            </section>

            <section class="rounded-xl border border-border bg-card p-4">
              <div class="flex items-center justify-between gap-2">
                <div>
                  <h3 class="text-sm font-semibold">{{ t('drafts.attachments.title') }}</h3>
                  <p class="mt-1 text-xs text-muted-foreground">
                    图片与文件会随确认结果复制交接给 Job。
                  </p>
                </div>
                <label class="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs font-medium hover:bg-muted">
                  <Paperclip class="size-3.5" />
                  {{ uploading ? t('drafts.attachments.uploading') : t('drafts.attachments.add') }}
                  <input type="file" class="hidden" :disabled="uploading || selectedBusy" @change="upload" />
                </label>
              </div>
              <div v-if="details.attachments.length" class="mt-3 space-y-2">
                <div
                  v-for="attachment in details.attachments"
                  :key="attachment.id"
                  class="flex items-center justify-between gap-2 rounded-lg bg-muted/60 px-3 py-2"
                >
                  <div class="min-w-0">
                    <p class="truncate text-xs font-medium">{{ attachment.displayName }}</p>
                    <p class="text-[11px] text-muted-foreground">{{ formatBytes(attachment.sizeBytes) }}</p>
                  </div>
                  <button type="button" class="text-muted-foreground hover:text-destructive" @click="removeAttachment(attachment.id)">
                    <X class="size-3.5" />
                  </button>
                </div>
              </div>
            </section>

            <div class="rounded-xl border border-primary/20 bg-primary/5 p-4">
              <div class="flex items-start gap-3">
                <Sparkles class="mt-0.5 size-5 text-primary" />
                <div class="min-w-0 flex-1">
                  <h3 class="text-sm font-semibold">生成执行树</h3>
                  <p class="mt-1 text-xs leading-5 text-muted-foreground">
                    只有需求明确确认后才能生成。每个 Work 会被拆成约 3–15 分钟的有序任务。
                  </p>
                  <Button class="mt-3 w-full" :disabled="!canGenerate" @click="generateTree">
                    <Loader2 v-if="generating" class="size-4 animate-spin" />
                    <Sparkles v-else class="size-4" />
                    {{ details.executionTree ? t('drafts.regenerate') : t('drafts.generate') }}
                  </Button>
                </div>
              </div>
            </div>
          </div>

          <div v-else>
            <ExecutionTreeView v-if="details.executionTree" :tree="details.executionTree.tree" />
            <div v-else class="rounded-xl border border-dashed border-border p-10 text-center">
              <ChevronRight class="mx-auto size-8 text-muted-foreground/50" />
              <p class="mt-3 text-sm font-medium">执行树尚未生成</p>
              <p class="mt-1 text-xs text-muted-foreground">先在对话中确认完整需求，再由 Planner 生成。</p>
            </div>
          </div>
        </div>

        <footer v-if="rightTab === 'tree' && details.executionTree" class="shrink-0 border-t border-border bg-card p-4">
          <Button
            class="w-full"
            :disabled="confirming || details.draft.status === 'submitted'"
            @click="confirmTree"
          >
            <Loader2 v-if="confirming" class="size-4 animate-spin" />
            <CheckCircle2 v-else class="size-4" />
            {{ details.draft.status === 'submitted' ? t('drafts.submitted') : t('drafts.confirm') }}
          </Button>
          <p class="mt-2 text-center text-[11px] text-muted-foreground">
            确认后草案、执行树和附件会成为 Job 自有快照。
          </p>
        </footer>
      </div>
    </section>

    <section v-else class="flex flex-1 items-center justify-center p-8">
      <div class="max-w-md text-center">
        <MessageSquareText class="mx-auto size-10 text-muted-foreground/50" />
        <h2 class="mt-4 text-lg font-semibold">通过对话创建任务</h2>
        <p class="mt-2 text-sm leading-6 text-muted-foreground">
          不需要先写完整规格。告诉 Planner 你的初步想法，它会反问、整理、确认，再生成执行树。
        </p>
        <Button class="mt-5" @click="openNew"><Plus class="size-4" />开始创建任务</Button>
      </div>
    </section>

    <div v-if="showNew" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4">
      <form class="w-full max-w-xl rounded-2xl border border-border bg-background p-5 shadow-2xl" @submit.prevent="createPlanner">
        <div class="flex items-start justify-between gap-3">
          <div>
            <h2 class="text-lg font-semibold">创建任务规划会话</h2>
            <p class="mt-1 text-sm text-muted-foreground">先说目标，不完整也没关系。</p>
          </div>
          <Button variant="ghost" size="sm" class="size-8 px-0" @click="showNew = false">
            <X class="size-4" />
          </Button>
        </div>
        <label class="mt-5 block text-xs font-medium">
          工作区
          <select v-model="newWorkspaceId" class="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
            <option v-for="workspace in home.workspaces.value" :key="workspace.id" :value="workspace.id">
              {{ workspace.title }} · {{ workspace.rootPath }}
            </option>
          </select>
        </label>
        <label class="mt-4 block text-xs font-medium">
          Provider
          <select v-model="newProvider" class="mt-2 h-10 w-full rounded-md border border-border bg-background px-3 text-sm">
            <option v-for="provider in home.providers.value" :key="provider.code" :value="provider.code">
              {{ provider.label }} · {{ provider.authenticated ? '宿主已登录' : '需要宿主登录' }}
            </option>
          </select>
        </label>
        <label class="mt-4 block text-xs font-medium">
          你想完成什么
          <textarea
            v-model="newGoal"
            rows="6"
            autofocus
            class="mt-2 w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus:ring-2 focus:ring-ring"
            placeholder="例如：重构现有登录模块，保持原业务能力，改成宿主授权并补齐桌面端 E2E…"
          />
        </label>
        <p v-if="home.workspaces.value.length === 0" class="mt-3 text-sm text-amber-700">
          请先从左侧项目区添加一个本地工作区。
        </p>
        <div class="mt-5 flex justify-end gap-2">
          <Button variant="outline" @click="showNew = false">取消</Button>
          <Button type="submit" :disabled="creating || !newWorkspaceId || !newGoal.trim()">
            <Loader2 v-if="creating" class="size-4 animate-spin" />
            <Send v-else class="size-4" />
            开始对话
          </Button>
        </div>
      </form>
    </div>
  </div>
</template>
