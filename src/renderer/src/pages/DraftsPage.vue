<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppHeader from '@renderer/components/AppHeader.vue'
import ExecutionTreeView from '@renderer/components/draft/ExecutionTreeView.vue'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Label from '@renderer/components/ui/Label.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { translateApiError } from '@renderer/i18n/translateApiError'
import {
  createDraft,
  deleteDraft as removeDraft,
  draftAttachmentUrl,
  fetchDraft,
  fetchDrafts,
  removeDraftAttachment,
  streamDraftGeneration,
  updateDraft,
  uploadDraftAttachment,
  confirmDraftExecutionTree,
  type DraftContentInput,
  type DraftDetails,
  type DraftRecord
} from '@renderer/api/drafts'
import { fetchConversationWorkspaces, type ConversationWorkspace } from '@renderer/api/conversation'

const { t } = useI18n()
const { data } = useBootstrap()
const workspaces = ref<ConversationWorkspace[]>([])
const drafts = ref<DraftRecord[]>([])
const selectedId = ref<string | null>(null)
const details = ref<DraftDetails | null>(null)
const loading = ref(true)
const detailsLoading = ref(false)
const saving = ref(false)
const uploading = ref(false)
const generating = ref(false)
const confirming = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)
const progressCharacters = ref(0)
const thinking = ref('')
const generationAbort = ref<AbortController | null>(null)
const creating = ref(false)

const emptyForm = (): DraftContentInput => ({
  workspaceId: workspaces.value[0]?.id ?? '',
  title: '',
  objective: '',
  requirements: '',
  constraints: '',
  acceptanceCriteria: ''
})
const form = ref<DraftContentInput>(emptyForm())
const originalContent = ref('')

const locked = computed(
  () => details.value?.draft.status === 'submitted' || details.value?.draft.status === 'generating'
)
const dirty = computed(() => JSON.stringify(form.value) !== originalContent.value)

function reportError(cause: unknown): void {
  error.value = translateApiError(cause instanceof Error ? cause.message : String(cause), t)
}
function setForm(draft: DraftRecord): void {
  form.value = {
    workspaceId: draft.workspaceId,
    title: draft.title,
    objective: draft.objective,
    requirements: draft.requirements,
    constraints: draft.constraints,
    acceptanceCriteria: draft.acceptanceCriteria
  }
  originalContent.value = JSON.stringify(form.value)
}
function workspaceName(id: string): string {
  return workspaces.value.find((workspace) => workspace.id === id)?.title ?? id
}
function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

async function loadDrafts(preferredId?: string): Promise<void> {
  drafts.value = (await fetchDrafts()).data
  const target =
    drafts.value.find((draft) => draft.id === preferredId) ??
    drafts.value.find((draft) => draft.id === selectedId.value) ??
    drafts.value[0]
  if (target) await selectDraft(target.id)
  else startCreate()
}
async function selectDraft(id: string): Promise<void> {
  selectedId.value = id
  creating.value = false
  detailsLoading.value = true
  error.value = null
  success.value = null
  try {
    details.value = (await fetchDraft(id)).data
    setForm(details.value.draft)
  } catch (cause) {
    reportError(cause)
  } finally {
    detailsLoading.value = false
  }
}
function startCreate(): void {
  selectedId.value = null
  details.value = null
  creating.value = true
  form.value = emptyForm()
  originalContent.value = JSON.stringify(form.value)
  error.value = null
  success.value = null
}
async function save(): Promise<DraftRecord | null> {
  saving.value = true
  error.value = null
  success.value = null
  try {
    let saved: DraftRecord
    if (!details.value) {
      saved = (await createDraft(form.value)).data
      selectedId.value = saved.id
      creating.value = false
    } else if (dirty.value) {
      saved = (
        await updateDraft(details.value.draft.id, {
          expectedRevision: details.value.draft.revision,
          title: form.value.title,
          objective: form.value.objective,
          requirements: form.value.requirements,
          constraints: form.value.constraints,
          acceptanceCriteria: form.value.acceptanceCriteria
        })
      ).data
    } else {
      return details.value.draft
    }
    await loadDrafts(saved.id)
    success.value = t('drafts.saved')
    return details.value?.draft ?? saved
  } catch (cause) {
    reportError(cause)
    return null
  } finally {
    saving.value = false
  }
}
async function generate(): Promise<void> {
  const saved = await save()
  if (!saved) return
  generating.value = true
  progressCharacters.value = 0
  thinking.value = ''
  error.value = null
  success.value = null
  const controller = new AbortController()
  generationAbort.value = controller
  try {
    await streamDraftGeneration(
      saved.id,
      (event) => {
        if (event.type === 'thinking') thinking.value += event.content
        if (event.type === 'progress') progressCharacters.value = event.receivedCharacters
        if (event.type === 'completed') progressCharacters.value = JSON.stringify(event.tree).length
      },
      controller.signal
    )
    await loadDrafts(saved.id)
    success.value = t('drafts.generated')
  } catch (cause) {
    if (controller.signal.aborted) success.value = t('drafts.cancelled')
    else reportError(cause)
    await loadDrafts(saved.id).catch(() => undefined)
  } finally {
    generationAbort.value = null
    generating.value = false
  }
}
function stopGeneration(): void {
  generationAbort.value?.abort()
}
async function upload(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  const current = details.value
  input.value = ''
  if (!file || !current) return
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
async function deleteAttachment(id: string): Promise<void> {
  const current = details.value
  if (!current) return
  error.value = null
  try {
    await removeDraftAttachment(current.draft.id, id, current.draft.revision)
    await selectDraft(current.draft.id)
  } catch (cause) {
    reportError(cause)
  }
}
async function confirmTree(): Promise<void> {
  const current = details.value
  if (!current?.executionTree) return
  if (!window.confirm(t('drafts.confirmPrompt'))) return
  confirming.value = true
  error.value = null
  try {
    await confirmDraftExecutionTree(
      current.draft.id,
      current.draft.revision,
      current.executionTree.id
    )
    await loadDrafts(current.draft.id)
    success.value = t('drafts.submitted')
  } catch (cause) {
    reportError(cause)
  } finally {
    confirming.value = false
  }
}
async function deleteCurrent(): Promise<void> {
  const current = details.value
  if (!current) return
  const prompt = current.handoff ? t('drafts.deleteSubmittedPrompt') : t('drafts.deletePrompt')
  if (!window.confirm(prompt)) return
  try {
    await removeDraft(current.draft.id)
    selectedId.value = null
    details.value = null
    await loadDrafts()
  } catch (cause) {
    reportError(cause)
  }
}

onMounted(async () => {
  loading.value = true
  try {
    workspaces.value = (await fetchConversationWorkspaces()).data
    form.value = emptyForm()
    originalContent.value = JSON.stringify(form.value)
    await loadDrafts()
  } catch (cause) {
    reportError(cause)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <main class="flex h-full min-h-0 flex-col bg-background">
    <AppHeader :username="data?.username" />
    <div class="flex min-h-0 flex-1">
      <aside class="flex w-72 shrink-0 flex-col border-r border-border bg-card">
        <div class="flex items-center justify-between gap-2 border-b border-border p-3">
          <span class="font-semibold">{{ t('drafts.title') }}</span>
          <Button size="sm" @click="startCreate">{{ t('drafts.new') }}</Button>
        </div>
        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <div v-if="loading" class="flex justify-center p-6"><Spinner /></div>
          <p v-else-if="drafts.length === 0" class="p-4 text-sm text-muted-foreground">
            {{ t('drafts.empty') }}
          </p>
          <button
            v-for="draft in drafts"
            :key="draft.id"
            type="button"
            class="mb-1 w-full rounded-md px-3 py-2 text-left hover:bg-muted"
            :class="selectedId === draft.id ? 'bg-muted' : ''"
            @click="selectDraft(draft.id)"
          >
            <span class="block truncate text-sm font-medium">{{ draft.title }}</span>
            <span
              class="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground"
            >
              <span class="truncate">{{ workspaceName(draft.workspaceId) }}</span>
              <span>{{ t(`drafts.status.${draft.status}`) }}</span>
            </span>
          </button>
        </div>
      </aside>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="mx-auto w-full max-w-5xl space-y-5 p-4 sm:p-6">
          <ErrorAlert v-if="error" :message="error" />
          <p v-if="success" class="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">
            {{ success }}
          </p>
          <div v-if="detailsLoading" class="flex justify-center py-12"><Spinner /></div>
          <div
            v-else-if="workspaces.length === 0"
            class="rounded-lg border border-dashed p-10 text-center"
          >
            <h1 class="text-lg font-semibold">{{ t('drafts.noWorkspace') }}</h1>
            <RouterLink to="/home" class="mt-3 inline-block text-sm text-primary underline">
              {{ t('drafts.goChat') }}
            </RouterLink>
          </div>
          <template v-else>
            <section class="rounded-lg border border-border bg-card p-4 sm:p-5">
              <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 class="text-xl font-semibold">
                    {{ creating ? t('drafts.createTitle') : form.title }}
                  </h1>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ t('drafts.boundaryHint') }}
                  </p>
                </div>
                <span v-if="details" class="rounded bg-muted px-2 py-1 text-xs">
                  {{ t(`drafts.status.${details.draft.status}`) }} · r{{ details.draft.revision }}
                </span>
              </div>
              <div class="grid gap-4">
                <div class="space-y-2">
                  <Label for="draft-workspace">{{ t('drafts.workspace') }}</Label>
                  <select
                    id="draft-workspace"
                    v-model="form.workspaceId"
                    class="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    :disabled="!!details"
                  >
                    <option
                      v-for="workspace in workspaces"
                      :key="workspace.id"
                      :value="workspace.id"
                    >
                      {{ workspace.title }} — {{ workspace.rootPath }}
                    </option>
                  </select>
                </div>
                <div class="space-y-2">
                  <Label for="draft-title">{{ t('drafts.fields.title') }}</Label>
                  <Input id="draft-title" v-model="form.title" :disabled="locked" />
                </div>
                <div class="space-y-2">
                  <Label for="draft-objective">{{ t('drafts.fields.objective') }}</Label>
                  <textarea
                    id="draft-objective"
                    v-model="form.objective"
                    rows="3"
                    class="draft-textarea"
                    :disabled="locked"
                  />
                </div>
                <div class="space-y-2">
                  <Label for="draft-requirements">{{ t('drafts.fields.requirements') }}</Label>
                  <textarea
                    id="draft-requirements"
                    v-model="form.requirements"
                    rows="8"
                    class="draft-textarea"
                    :disabled="locked"
                  />
                </div>
                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="space-y-2">
                    <Label for="draft-constraints">{{ t('drafts.fields.constraints') }}</Label>
                    <textarea
                      id="draft-constraints"
                      v-model="form.constraints"
                      rows="6"
                      class="draft-textarea"
                      :disabled="locked"
                    />
                  </div>
                  <div class="space-y-2">
                    <Label for="draft-acceptance">{{ t('drafts.fields.acceptance') }}</Label>
                    <textarea
                      id="draft-acceptance"
                      v-model="form.acceptanceCriteria"
                      rows="6"
                      class="draft-textarea"
                      :disabled="locked"
                    />
                  </div>
                </div>
              </div>
              <div class="mt-5 flex flex-wrap gap-2">
                <Button :disabled="saving || locked" @click="save">
                  {{ saving ? t('drafts.saving') : t('drafts.save') }}
                </Button>
                <Button
                  v-if="details"
                  variant="outline"
                  :disabled="generating || locked"
                  @click="generate"
                >
                  {{ t(details.executionTree ? 'drafts.regenerate' : 'drafts.generate') }}
                </Button>
                <Button v-if="generating" variant="outline" @click="stopGeneration">
                  {{ t('drafts.stop') }}
                </Button>
                <Button
                  v-if="details"
                  variant="outline"
                  class="text-destructive"
                  :disabled="generating"
                  @click="deleteCurrent"
                >
                  {{ t('drafts.delete') }}
                </Button>
              </div>
            </section>

            <section v-if="details" class="rounded-lg border border-border bg-card p-4 sm:p-5">
              <div class="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="font-semibold">{{ t('drafts.attachments.title') }}</h2>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ t('drafts.attachments.hint') }}
                  </p>
                </div>
                <label
                  class="cursor-pointer rounded-md border border-input px-3 py-2 text-sm"
                  :class="locked ? 'pointer-events-none opacity-50' : ''"
                >
                  {{ uploading ? t('drafts.attachments.uploading') : t('drafts.attachments.add') }}
                  <input
                    type="file"
                    class="hidden"
                    :disabled="uploading || locked"
                    @change="upload"
                  />
                </label>
              </div>
              <div class="mt-4 space-y-2">
                <p v-if="details.attachments.length === 0" class="text-sm text-muted-foreground">
                  {{ t('drafts.attachments.empty') }}
                </p>
                <div
                  v-for="attachment in details.attachments"
                  :key="attachment.id"
                  class="flex items-center justify-between gap-3 rounded border p-3"
                >
                  <div class="min-w-0">
                    <a
                      :href="draftAttachmentUrl(details.draft.id, attachment.id)"
                      class="block truncate text-sm font-medium underline"
                    >
                      {{ attachment.displayName }}
                    </a>
                    <span class="text-xs text-muted-foreground"
                      >{{ formatBytes(attachment.sizeBytes) }} · {{ attachment.id }}</span
                    >
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    :disabled="locked"
                    @click="deleteAttachment(attachment.id)"
                  >
                    {{ t('drafts.attachments.remove') }}
                  </Button>
                </div>
              </div>
            </section>

            <section v-if="generating" class="rounded-lg border border-border bg-card p-5">
              <div class="flex items-center gap-2">
                <Spinner /> <strong>{{ t('drafts.generating') }}</strong>
              </div>
              <p class="mt-2 text-xs text-muted-foreground">
                {{ t('drafts.progress', { count: progressCharacters }) }}
              </p>
              <details v-if="thinking" class="mt-3 text-xs text-muted-foreground">
                <summary>{{ t('drafts.thinking') }}</summary>
                <pre class="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{{ thinking }}</pre>
              </details>
            </section>

            <section
              v-if="details?.executionTree"
              class="rounded-lg border border-border bg-card p-4 sm:p-5"
            >
              <div class="mb-5 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 class="font-semibold">{{ t('drafts.treeTitle') }}</h2>
                  <p class="mt-1 text-xs text-muted-foreground">
                    v{{ details.executionTree.treeRevision }} · {{ t('drafts.treeImmutableHint') }}
                  </p>
                </div>
                <Button
                  v-if="!details.handoff"
                  :disabled="confirming || dirty"
                  @click="confirmTree"
                >
                  {{ confirming ? t('drafts.confirming') : t('drafts.confirm') }}
                </Button>
              </div>
              <ExecutionTreeView :tree="details.executionTree.tree" />
            </section>

            <section
              v-if="details?.handoff"
              class="rounded-lg border border-emerald-200 bg-emerald-50 p-5 text-emerald-950"
            >
              <h2 class="font-semibold">{{ t('drafts.handoff.title') }}</h2>
              <p class="mt-2 text-sm">{{ t('drafts.handoff.pending') }}</p>
              <dl class="mt-3 grid gap-1 text-xs">
                <div>
                  ID: <code>{{ details.handoff.id }}</code>
                </div>
                <div>
                  {{ t('drafts.handoff.attachments', { count: details.handoff.attachmentCount }) }}
                </div>
              </dl>
            </section>
          </template>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.draft-textarea {
  width: 100%;
  resize: vertical;
  border: 1px solid var(--color-input);
  border-radius: 0.375rem;
  background: var(--color-background);
  padding: 0.625rem 0.75rem;
  font-size: 0.875rem;
  line-height: 1.5;
}
</style>
