import { inject, onMounted, provide, ref, type InjectionKey, type Ref } from 'vue'
import { fetchBootstrap } from '@renderer/api/auth'
import type { BootstrapData } from '@renderer/api/types'
import { clearToken } from '@renderer/auth/token'
import { i18n } from '@renderer/i18n'

export interface BootstrapContext {
  data: Ref<BootstrapData | null>
  loading: Ref<boolean>
  error: Ref<string | null>
  refresh: () => Promise<void>
}

const BootstrapKey: InjectionKey<BootstrapContext> = Symbol('bootstrap')

export function provideBootstrap(): BootstrapContext {
  const data = ref<BootstrapData | null>(null)
  const loading = ref(true)
  const error = ref<string | null>(null)

  async function refresh(): Promise<void> {
    loading.value = true
    error.value = null
    try {
      const res = await fetchBootstrap()
      data.value = res.data
      if (!res.data.authenticated) {
        clearToken()
      }
    } catch (e) {
      error.value = e instanceof Error ? e.message : i18n.global.t('bootstrap.bootstrapFailed')
      data.value = null
      clearToken()
    } finally {
      loading.value = false
    }
  }

  const ctx: BootstrapContext = { data, loading, error, refresh }
  provide(BootstrapKey, ctx)
  onMounted(() => {
    void refresh()
  })
  return ctx
}

export function useBootstrap(): BootstrapContext {
  const ctx = inject(BootstrapKey)
  if (!ctx) {
    throw new Error('useBootstrap must be used within BootstrapProvider')
  }
  return ctx
}
