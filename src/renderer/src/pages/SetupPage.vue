<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setup } from '@renderer/api/auth'
import { api } from '@renderer/api/client'
import { setToken } from '@renderer/auth/token'
import CredentialsForm from '@renderer/components/auth/CredentialsForm.vue'
import Button from '@renderer/components/ui/Button.vue'
import Dialog from '@renderer/components/ui/Dialog.vue'
import Input from '@renderer/components/ui/Input.vue'
import Label from '@renderer/components/ui/Label.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import FolderBrowsePanel from '@renderer/components/shared/FolderBrowsePanel.vue'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import { useFolderBrowse } from '@renderer/composables/useFolderBrowse'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { withTrailingSeparator } from '@renderer/lib/workspace'
import {
  fetchStorageBootstrap,
  initializeStorageTarget,
  recoverStorageTarget,
  validateStorageTarget
} from '@renderer/api/storage'

const { t } = useI18n()
const router = useRouter()
const { refresh, data: bootstrapData } = useBootstrap()

function storageErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return translateApiError(message, t)
}

const needSetupToken = computed(() => bootstrapData.value?.setupTokenRequired ?? false)
const storagePhase = computed(() => bootstrapData.value?.storagePhase)
const needsStorage = computed(
  () => storagePhase.value === 'selection_required' || storagePhase.value === 'recovery_required'
)
const storagePath = ref('')
const storageIssue = ref<string | null>(null)
const pickerOpen = ref(false)
const creatingFolder = ref(false)

const {
  query,
  parentPath,
  entries,
  newFolderName,
  loading: browsing,
  error: browseError,
  loadBrowse,
  currentDirectoryPath,
  openEntry,
  goParent,
  joinNewFolderPath,
  start: startBrowse
} = useFolderBrowse({ active: pickerOpen })

watch(storagePath, () => {
  storageIssue.value = null
})

onMounted(async () => {
  if (!needsStorage.value) return
  try {
    const response = await fetchStorageBootstrap()
    storagePath.value = response.data.defaultCandidate
    storageIssue.value = response.data.issue
      ? translateApiError(response.data.issue, t)
      : null
  } catch (error) {
    storageIssue.value = storageErrorMessage(error)
  }
})

async function openStoragePicker(): Promise<void> {
  // Always use the in-app picker so "create folder" works in desktop and server modes.
  pickerOpen.value = true
  startBrowse()
  if (storagePath.value.trim()) {
    query.value = withTrailingSeparator(storagePath.value.trim())
    void loadBrowse(query.value)
  }
}

function closeStoragePicker(): void {
  pickerOpen.value = false
}

function selectStoragePath(path: string): void {
  const target = path.trim()
  if (!target) {
    browseError.value = t('folderPicker.selectRequired')
    return
  }
  storagePath.value = target
  pickerOpen.value = false
}

async function createAndSelectFolder(): Promise<void> {
  const target = joinNewFolderPath()
  if (!target) {
    browseError.value = t('folderPicker.folderNameRequired')
    return
  }
  creatingFolder.value = true
  browseError.value = null
  try {
    const created = await api<{ path: string }>('/api/fs/mkdir', {
      method: 'POST',
      body: JSON.stringify({ path: target })
    })
    const path = created.data.path || target
    storagePath.value = path
    newFolderName.value = ''
    query.value = withTrailingSeparator(path)
    await loadBrowse(query.value)
    pickerOpen.value = false
  } catch (error) {
    browseError.value = error instanceof Error ? error.message : t('folderPicker.browseFailed')
  } finally {
    creatingFolder.value = false
  }
}

async function ensureStorageReady(): Promise<void> {
  storageIssue.value = null
  const response = await validateStorageTarget(storagePath.value)
  const action =
    response.data.action ??
    (storagePhase.value === 'recovery_required' ? 'recover' : 'initialize')
  if (action === 'recover') {
    await recoverStorageTarget(response.data.canonicalPath, response.data.nonce)
  } else {
    await initializeStorageTarget(response.data.canonicalPath, response.data.nonce)
  }
  await refresh()
}

async function onSubmit(payload: {
  username: string
  password: string
  setupToken?: string
}): Promise<void> {
  if (needsStorage.value) {
    if (!storagePath.value.trim()) {
      // Keep the error next to the path field only — do not rethrow into CredentialsForm.
      storageIssue.value = t('setup.storagePathRequired')
      return
    }
    try {
      await ensureStorageReady()
    } catch (error) {
      storageIssue.value = storageErrorMessage(error)
      return
    }

    // Recovered installs may already have an account — skip /api/setup.
    if (bootstrapData.value?.initialized) {
      await router.replace(bootstrapData.value.authenticated ? '/home' : '/login')
      return
    }
  }

  const res = await setup(payload.username, payload.password, payload.setupToken)
  setToken(res.data.token, res.data.expires_at)
  await refresh()
  await router.replace('/home')
}
</script>

<template>
  <div class="h-full min-h-0 min-w-0">
    <PageShell max-width="xl">
      <CredentialsForm
        :title="t('setup.title')"
        :description="t(needsStorage ? 'setup.combinedDescription' : 'setup.description')"
        :submit-label="t('setup.submit')"
        :submitting-label="t('setup.submitting')"
        password-auto-complete="new-password"
        :show-setup-token="needSetupToken"
        :enforce-credentials-policy="true"
        :on-submit="onSubmit"
      >
        <template v-if="needsStorage" #before="{ disabled }">
          <div class="flex min-w-0 flex-col gap-2 border-b pb-4">
            <Label for="storage-path">{{ t('setup.storagePathLabel') }}</Label>
            <p class="text-xs leading-relaxed text-muted-foreground break-words">
              {{
                t(
                  storagePhase === 'recovery_required'
                    ? 'setup.storageRecoveryDescription'
                    : 'setup.storageDescription'
                )
              }}
            </p>
            <!-- Always stack: long Windows paths + Browse overflow every phone/tablet width. -->
            <div class="flex min-w-0 flex-col gap-2">
              <Input
                id="storage-path"
                v-model="storagePath"
                class="min-w-0 w-full font-mono"
                :disabled="disabled"
              />
              <Button
                type="button"
                variant="outline"
                class="w-full shrink-0"
                :disabled="disabled"
                @click="openStoragePicker"
              >
                {{ t('setup.storageBrowse') }}
              </Button>
            </div>
            <p
              v-if="storageIssue"
              class="rounded-md bg-destructive/10 p-3 text-sm text-destructive break-words"
            >
              {{ storageIssue }}
            </p>
          </div>
        </template>
      </CredentialsForm>
    </PageShell>

    <Dialog
      :open="pickerOpen"
      class="flex h-[min(92dvh,720px)] min-h-0 max-h-[min(92dvh,720px)] w-full max-w-2xl flex-col sm:h-[min(90dvh,720px)] sm:max-h-[min(90dvh,720px)]"
      @close="closeStoragePicker"
    >
      <div class="shrink-0 border-b border-border px-3 py-3 sm:px-4 sm:py-4">
        <h2 class="text-base font-semibold">{{ t('setup.storageBrowseTitle') }}</h2>
        <p class="mt-1 text-sm text-muted-foreground break-words">
          {{ t('setup.storageBrowseHint') }}
        </p>
      </div>
      <FolderBrowsePanel
        fill-height
        :query="query"
        :parent-path="parentPath"
        :current-path="currentDirectoryPath()"
        :entries="entries"
        :new-folder-name="newFolderName"
        :loading="browsing"
        :submitting="creatingFolder"
        :error="browseError"
        :select-current-label="t('setup.storageSelectDirectory')"
        :create-folder-label="t('setup.storageCreateFolder')"
        @update:query="query = $event"
        @update:new-folder-name="newFolderName = $event"
        @go-parent="goParent"
        @open-entry="openEntry"
        @select="selectStoragePath"
        @create-folder="createAndSelectFolder"
      />
    </Dialog>
  </div>
</template>
