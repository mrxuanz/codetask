<script setup lang="ts">
import { useRoute } from 'vue-router'
import { useI18n } from 'vue-i18n'
import LanguageSwitcher from '@renderer/components/LanguageSwitcher.vue'

defineProps<{ username?: string }>()

const route = useRoute()
const { t } = useI18n()
</script>

<template>
  <header
    class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3 sm:px-5"
  >
    <div class="flex min-w-0 items-center gap-4">
      <RouterLink to="/home" class="shrink-0 font-semibold tracking-tight">CodeTask</RouterLink>
      <nav class="flex items-center gap-1 text-sm">
        <RouterLink
          to="/home"
          class="rounded-md px-3 py-2"
          :class="route.path === '/home' ? 'bg-muted font-medium' : 'text-muted-foreground'"
        >
          {{ t('conversation.nav.chat') }}
        </RouterLink>
        <RouterLink
          to="/drafts"
          class="rounded-md px-3 py-2"
          :class="route.path === '/drafts' ? 'bg-muted font-medium' : 'text-muted-foreground'"
        >
          {{ t('conversation.nav.drafts') }}
        </RouterLink>
        <RouterLink
          to="/jobs"
          class="rounded-md px-3 py-2"
          :class="route.path === '/jobs' ? 'bg-muted font-medium' : 'text-muted-foreground'"
        >
          {{ t('conversation.nav.jobs') }}
        </RouterLink>
        <RouterLink
          to="/settings"
          class="rounded-md px-3 py-2"
          :class="route.path === '/settings' ? 'bg-muted font-medium' : 'text-muted-foreground'"
        >
          {{ t('conversation.nav.settings') }}
        </RouterLink>
      </nav>
    </div>
    <div class="flex min-w-0 items-center gap-3">
      <span v-if="username" class="hidden truncate text-xs text-muted-foreground sm:block">
        {{ username }}
      </span>
      <LanguageSwitcher />
    </div>
  </header>
</template>
