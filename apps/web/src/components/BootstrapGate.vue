<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterView, useRoute, useRouter } from 'vue-router'
import { useBootstrap } from '@renderer/composables/useBootstrap'
import Card from '@renderer/components/ui/Card.vue'
import CardContent from '@renderer/components/ui/CardContent.vue'
import ErrorAlert from '@renderer/components/ui/ErrorAlert.vue'
import PageShell from '@renderer/components/ui/PageShell.vue'
import Spinner from '@renderer/components/ui/Spinner.vue'
import { translateApiError } from '@renderer/i18n/translateApiError'

const { t } = useI18n()

const { data, loading, error } = useBootstrap()
const route = useRoute()
const router = useRouter()

const connectionErrorMessage = computed(() =>
  t('bootstrap.connectionError', {
    error: error.value ? translateApiError(error.value, t) : t('common.unknown')
  })
)

const redirectTarget = computed(() => {
  if (loading.value || error.value || !data.value) return null

  const { initialized, authenticated } = data.value
  const path = route.path

  if (!initialized && path !== '/setup') return '/setup'
  if (initialized && !authenticated && path !== '/login') return '/login'
  if (initialized && authenticated && (path === '/login' || path === '/setup')) return '/home'
  if (path === '/home' && !authenticated) return '/login'

  return null
})

watch(
  redirectTarget,
  (target) => {
    if (target) void router.replace(target)
  },
  { immediate: true }
)
</script>

<template>
  <div class="h-full min-h-0 min-w-0">
    <PageShell v-if="loading" max-width="sm">
      <Card>
        <CardContent class="py-8">
          <Spinner />
        </CardContent>
      </Card>
    </PageShell>

    <PageShell v-else-if="error || !data" max-width="sm">
      <ErrorAlert :message="connectionErrorMessage" />
    </PageShell>

    <RouterView v-else-if="!redirectTarget" />
  </div>
</template>
