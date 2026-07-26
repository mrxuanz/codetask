<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { changePassword, logoutAll } from '@renderer/api/auth'
import Button from '@renderer/components/ui/Button.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import Label from '@renderer/components/ui/Label.vue'
import PasswordInput from '@renderer/components/ui/PasswordInput.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'
import { validateSetupPassword } from '@shared/auth/credentials-policy'
import { turnErrorI18nKey } from '@shared/turn-errors'

const { t } = useI18n()

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const changing = ref(false)
const loggingOut = ref(false)
const error = ref<string | null>(null)
const success = ref<string | null>(null)

async function submitPasswordChange(): Promise<void> {
  error.value = null
  success.value = null

  const violation = validateSetupPassword(newPassword.value)
  if (violation) {
    error.value = t(turnErrorI18nKey(violation.code), violation.params ?? {})
    return
  }
  if (newPassword.value !== confirmPassword.value) {
    error.value = t('workspace.settings.security.passwordMismatch')
    return
  }

  changing.value = true
  try {
    await changePassword(currentPassword.value, newPassword.value)
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    success.value = t('workspace.settings.security.passwordChanged')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    error.value = translateApiError(message, t)
  } finally {
    changing.value = false
  }
}

async function signOutEverywhere(): Promise<void> {
  error.value = null
  success.value = null
  loggingOut.value = true
  try {
    await logoutAll()
    window.location.replace('/login')
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    error.value = translateApiError(message, t)
    loggingOut.value = false
  }
}
</script>

<template>
  <div class="space-y-6">
    <form class="space-y-4" @submit.prevent="submitPasswordChange">
      <div class="space-y-2">
        <Label for="security-current-password">
          {{ t('workspace.settings.security.currentPassword') }}
        </Label>
        <PasswordInput
          id="security-current-password"
          v-model="currentPassword"
          autocomplete="current-password"
          required
        />
      </div>
      <div class="space-y-2">
        <Label for="security-new-password">
          {{ t('workspace.settings.security.newPassword') }}
        </Label>
        <PasswordInput
          id="security-new-password"
          v-model="newPassword"
          autocomplete="new-password"
          required
        />
      </div>
      <div class="space-y-2">
        <Label for="security-confirm-password">
          {{ t('workspace.settings.security.confirmPassword') }}
        </Label>
        <PasswordInput
          id="security-confirm-password"
          v-model="confirmPassword"
          autocomplete="new-password"
          required
        />
      </div>
      <p class="text-xs leading-relaxed text-muted-foreground">
        {{ t('workspace.settings.security.passwordHint') }}
      </p>
      <ErrorAlert v-if="error" :message="error" />
      <p v-if="success" class="text-sm text-emerald-600 dark:text-emerald-400">{{ success }}</p>
      <Button type="submit" :disabled="changing || loggingOut">
        {{
          changing
            ? t('workspace.settings.security.changingPassword')
            : t('workspace.settings.security.changePassword')
        }}
      </Button>
    </form>

    <div class="border-t pt-5">
      <p class="text-sm font-medium">{{ t('workspace.settings.security.sessionsTitle') }}</p>
      <p class="mt-1 text-sm text-muted-foreground">
        {{ t('workspace.settings.security.sessionsDescription') }}
      </p>
      <Button
        type="button"
        variant="outline"
        class="mt-3"
        :disabled="changing || loggingOut"
        @click="signOutEverywhere"
      >
        {{
          loggingOut
            ? t('workspace.settings.security.signingOut')
            : t('workspace.settings.security.signOutEverywhere')
        }}
      </Button>
    </div>
  </div>
</template>
