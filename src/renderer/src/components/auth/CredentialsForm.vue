<script setup lang="ts">
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Button from '@renderer/components/ui/Button.vue'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import CardDescription from '@renderer/components/ui/CardDescription.vue'
import CardHeader from '@renderer/components/ui/CardHeader.vue'
import CardTitle from '@renderer/components/ui/CardTitle.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Input from '@renderer/components/ui/Input.vue'
import Label from '@renderer/components/ui/Label.vue'
import PasswordInput from '@renderer/components/ui/PasswordInput.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { fetchCaptcha } from '@renderer/api/auth'
import type { CaptchaChallenge } from '@renderer/api/types'
import { validateSetupCredentials } from '@shared/auth/credentials-policy'
import { turnErrorI18nKey } from '@shared/turn-errors'
import { clearSetupGrant, setSetupGrant } from '@renderer/auth/token'

const { t } = useI18n()

const props = defineProps<{
  title: string
  description: string
  submitLabel: string
  submittingLabel: string
  passwordAutoComplete: 'current-password' | 'new-password'
  showSetupToken: boolean
  enforceCredentialsPolicy?: boolean
  onSubmit: (payload: {
    username: string
    password: string
    captchaId?: string
    captchaAnswer?: string
    setupToken?: string
  }) => Promise<void>
  onCaptchaRequired?: () => void
}>()

const username = ref('')
const password = ref('')
const confirmPassword = ref('')
const setupToken = ref('')
const error = ref<string | null>(null)
const submitting = ref(false)
const captchaChallenge = ref<CaptchaChallenge | null>(null)
const captchaAnswer = ref('')
const captchaLoading = ref(false)

watch(setupToken, (value) => {
  setSetupGrant(value)
})

watch(
  () => props.showSetupToken,
  (val) => {
    if (!val) {
      setupToken.value = ''
      clearSetupGrant()
    }
  }
)

function normalizeSetupInputs(): void {
  if (!props.enforceCredentialsPolicy) return
  username.value = username.value.trim()
  setupToken.value = setupToken.value.trim()
}

function trimUsername(): void {
  username.value = username.value.trim()
}

function handleFieldBlur(): void {
  if (props.enforceCredentialsPolicy) {
    normalizeSetupInputs()
    return
  }
  trimUsername()
}

function onPasswordBlur(): void {
  // Passwords are byte-for-byte credentials; never silently normalize them.
}

async function loadCaptcha(): Promise<void> {
  captchaLoading.value = true
  try {
    const res = await fetchCaptcha()
    captchaChallenge.value = res.data
  } catch {
    error.value = t('common.captchaLoadFailed')
  } finally {
    captchaLoading.value = false
  }
}

async function handleSubmit(): Promise<void> {
  submitting.value = true
  error.value = null

  normalizeSetupInputs()

  if (props.enforceCredentialsPolicy) {
    const violation = validateSetupCredentials(username.value, password.value)
    if (violation) {
      error.value = t(turnErrorI18nKey(violation.code), violation.params ?? {})
      submitting.value = false
      return
    }

    if (password.value !== confirmPassword.value) {
      error.value = t('setup.passwordMismatch')
      submitting.value = false
      return
    }
  }

  try {
    await props.onSubmit({
      username: username.value,
      password: password.value,
      captchaId: captchaChallenge.value?.challengeId,
      captchaAnswer: captchaAnswer.value || undefined,
      setupToken: props.showSetupToken ? setupToken.value : undefined
    })
  } catch (err: unknown) {
    const apiErr = err as {
      message?: string
      data?: { captchaRequired?: boolean; retryAfterMs?: number }
    }
    if (apiErr.data?.captchaRequired) {
      captchaAnswer.value = ''
      await loadCaptcha()
      props.onCaptchaRequired?.()
      if (apiErr.data.retryAfterMs && apiErr.data.retryAfterMs > 0) {
        const retryAfterSec = Math.max(1, Math.ceil(apiErr.data.retryAfterMs / 1_000))
        error.value = `${t('errors.invalidCredentials')} (${retryAfterSec}s)`
      } else {
        error.value = t('login.captchaRequired')
      }
      return
    }
    const message = apiErr.message ?? t('common.operationFailed')
    error.value = translateApiError(message, t)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Card class="w-full min-w-0 overflow-hidden">
    <CardHeader class="space-y-2 px-4 pt-5 sm:px-6 sm:pt-6">
      <CardTitle class="text-lg sm:text-xl">{{ title }}</CardTitle>
      <CardDescription class="text-sm leading-relaxed break-words">{{
        description
      }}</CardDescription>
      <p
        v-if="enforceCredentialsPolicy"
        class="text-xs leading-relaxed text-muted-foreground break-words sm:text-sm"
      >
        {{ t('setup.credentialsHint') }}
      </p>
    </CardHeader>
    <CardContent class="px-4 pb-5 sm:px-6 sm:pb-6">
      <form class="flex min-w-0 flex-col gap-3 sm:gap-4" @submit.prevent="handleSubmit">
        <div v-if="showSetupToken" class="flex min-w-0 flex-col gap-2">
          <Label for="setupToken">{{ t('setup.setupTokenLabel') }}</Label>
          <Input
            id="setupToken"
            v-model="setupToken"
            :placeholder="t('setup.setupTokenPlaceholder')"
            autocomplete="off"
            required
            @blur="handleFieldBlur"
          />
        </div>
        <slot name="before" :disabled="submitting || captchaLoading" />
        <div class="flex min-w-0 flex-col gap-2">
          <Label for="username">{{ t('common.username') }}</Label>
          <Input
            id="username"
            v-model="username"
            :placeholder="t('common.usernamePlaceholder')"
            autocomplete="username"
            required
            @blur="handleFieldBlur"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-2">
          <Label for="password">{{ t('common.password') }}</Label>
          <PasswordInput
            id="password"
            v-model="password"
            :placeholder="t('common.passwordPlaceholder')"
            :autocomplete="passwordAutoComplete"
            required
            @blur="onPasswordBlur"
          />
        </div>
        <div v-if="enforceCredentialsPolicy" class="flex min-w-0 flex-col gap-2">
          <Label for="confirmPassword">{{ t('setup.confirmPassword') }}</Label>
          <PasswordInput
            id="confirmPassword"
            v-model="confirmPassword"
            :placeholder="t('setup.confirmPasswordPlaceholder')"
            autocomplete="new-password"
            required
            @blur="normalizeSetupInputs"
          />
        </div>
        <div v-if="captchaChallenge" class="flex min-w-0 flex-col gap-2">
          <Label>{{ t('common.captchaLabel') }}</Label>
          <img
            :src="captchaChallenge.image"
            alt="Captcha"
            class="h-12 w-full max-w-48 cursor-pointer rounded border"
            @click="loadCaptcha"
          />
          <Input
            v-model="captchaAnswer"
            :placeholder="t('common.captchaPlaceholder')"
            autocomplete="off"
            maxlength="6"
            required
          />
        </div>
        <Button v-if="captchaLoading" type="button" variant="outline" class="w-full" disabled>
          {{ t('common.captchaLoading') }}
        </Button>
        <ErrorAlert v-if="error" :message="error" />
        <Button type="submit" class="w-full" :disabled="submitting || captchaLoading">
          {{ submitting ? submittingLabel : submitLabel }}
        </Button>
      </form>
    </CardContent>
  </Card>
</template>
