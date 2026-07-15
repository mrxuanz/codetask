<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { setup } from '@renderer/api/auth'
import { setToken } from '@renderer/auth/token'
import CredentialsForm from '@renderer/components/auth/CredentialsForm.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import {
  fetchStorageBootstrap,
  initializeStorageTarget,
  recoverStorageTarget,
  validateStorageTarget
} from '@renderer/api/storage'

const { t } = useI18n()
const router = useRouter()
const { refresh, data: bootstrapData } = useBootstrap()

const needSetupToken = computed(() => bootstrapData.value?.setupTokenRequired ?? false)
const storagePhase = computed(() => bootstrapData.value?.storagePhase)
const storagePath = ref('')
const storageIssue = ref<string | null>(null)
const validationNonce = ref<string | null>(null)
const canonicalPath = ref<string | null>(null)
const storageBusy = ref(false)
const restartRequired = ref(false)
const canBrowse =
  typeof window !== 'undefined' && typeof window.api?.selectDataDirectory === 'function'

watch(storagePath, () => {
  validationNonce.value = null
  canonicalPath.value = null
  storageIssue.value = null
})

onMounted(async () => {
  if (!storagePhase.value) return
  try {
    const response = await fetchStorageBootstrap()
    storagePath.value = response.data.defaultCandidate
    storageIssue.value = response.data.issue ?? null
  } catch (error) {
    storageIssue.value = error instanceof Error ? error.message : String(error)
  }
})

async function chooseStorageDirectory(): Promise<void> {
  const selected = await window.api?.selectDataDirectory?.()
  if (selected) storagePath.value = selected
}

async function validateStorage(): Promise<void> {
  storageBusy.value = true
  storageIssue.value = null
  try {
    const response = await validateStorageTarget(storagePath.value)
    canonicalPath.value = response.data.canonicalPath
    validationNonce.value = response.data.nonce
  } catch (error) {
    storageIssue.value = error instanceof Error ? error.message : String(error)
  } finally {
    storageBusy.value = false
  }
}

async function initializeStorage(): Promise<void> {
  if (!validationNonce.value || !canonicalPath.value) return
  storageBusy.value = true
  storageIssue.value = null
  try {
    await initializeStorageTarget(canonicalPath.value, validationNonce.value)
    restartRequired.value = true
  } catch (error) {
    storageIssue.value = error instanceof Error ? error.message : String(error)
  } finally {
    storageBusy.value = false
  }
}

async function recoverStorage(): Promise<void> {
  if (!validationNonce.value || !canonicalPath.value) return
  storageBusy.value = true
  storageIssue.value = null
  try {
    await recoverStorageTarget(canonicalPath.value, validationNonce.value)
    restartRequired.value = true
  } catch (error) {
    storageIssue.value = error instanceof Error ? error.message : String(error)
  } finally {
    storageBusy.value = false
  }
}

async function onSubmit(payload: {
  username: string
  password: string
  setupToken?: string
}): Promise<void> {
  const res = await setup(payload.username, payload.password, payload.setupToken)
  setToken(res.data.token, res.data.expires_at)
  await refresh()
  await router.replace('/home')
}
</script>

<template>
  <PageShell>
    <div
      v-if="storagePhase === 'selection_required' || storagePhase === 'recovery_required'"
      class="w-full max-w-xl rounded-xl border bg-card p-6 text-card-foreground shadow-sm"
    >
      <h1 class="text-xl font-semibold">
        {{
          t(
            storagePhase === 'recovery_required'
              ? 'setup.storageRecoveryTitle'
              : 'setup.storageTitle'
          )
        }}
      </h1>
      <p class="mt-2 text-sm text-muted-foreground">
        {{
          t(
            storagePhase === 'recovery_required'
              ? 'setup.storageRecoveryDescription'
              : 'setup.storageDescription'
          )
        }}
      </p>

      <div v-if="restartRequired" class="mt-6 rounded-md bg-primary/10 p-4 text-sm">
        {{
          t(
            storagePhase === 'recovery_required'
              ? 'setup.storageRecovered'
              : 'setup.storageRestarting'
          )
        }}
      </div>

      <template v-else>
        <label for="storage-path" class="mt-6 block text-sm font-medium">
          {{ t('setup.storagePathLabel') }}
        </label>
        <div class="mt-2 flex gap-2">
          <input
            id="storage-path"
            v-model="storagePath"
            class="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            :disabled="storageBusy"
          />
          <button
            type="button"
            class="rounded-md border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
            :disabled="storageBusy || !canBrowse"
            @click="chooseStorageDirectory"
          >
            {{ t('setup.storageBrowse') }}
          </button>
        </div>

        <p v-if="canonicalPath" class="mt-3 break-all text-xs text-muted-foreground">
          {{ t('setup.storageValidatedPath', { path: canonicalPath }) }}
        </p>
        <p
          v-if="storageIssue"
          class="mt-3 rounded-md bg-destructive/10 p-3 text-sm text-destructive"
        >
          {{ storageIssue }}
        </p>

        <div class="mt-6 flex justify-end gap-2">
          <button
            v-if="!validationNonce"
            type="button"
            class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            :disabled="storageBusy || !storagePath.trim()"
            @click="validateStorage"
          >
            {{ storageBusy ? t('setup.storageValidating') : t('setup.storageValidate') }}
          </button>
          <button
            v-else
            type="button"
            class="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50"
            :disabled="storageBusy"
            @click="storagePhase === 'recovery_required' ? recoverStorage() : initializeStorage()"
          >
            {{
              storageBusy
                ? t(
                    storagePhase === 'recovery_required'
                      ? 'setup.storageRecovering'
                      : 'setup.storageInitializing'
                  )
                : t(
                    storagePhase === 'recovery_required'
                      ? 'setup.storageRecover'
                      : 'setup.storageConfirm'
                  )
            }}
          </button>
        </div>
      </template>
    </div>

    <CredentialsForm
      v-else
      :title="t('setup.title')"
      :description="t('setup.description')"
      :submit-label="t('setup.submit')"
      :submitting-label="t('setup.submitting')"
      password-auto-complete="new-password"
      :show-setup-token="needSetupToken"
      :enforce-credentials-policy="true"
      :on-submit="onSubmit"
    />
  </PageShell>
</template>
