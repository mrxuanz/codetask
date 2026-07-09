<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ConversationCore } from '@renderer/api/conversation'
import type { MessageAttachment } from '@shared/contracts/conversation'
import AttachmentPickerButton from '@renderer/components/home/AttachmentPickerButton.vue'
import Button from '@renderer/components/ui/Button.vue'
import { cn } from '@renderer/lib/utils'

export interface PendingAttachment {
  id: string
  file: File
  previewUrl: string
  kind: 'image' | 'file'
}

const props = defineProps<{
  cores: ConversationCore[]
  coreCode: string
  disabled?: boolean
  sending?: boolean
}>()

const emit = defineEmits<{
  coreChange: [code: string]
  send: [payload: { message: string; files: File[] }]
}>()

const { t } = useI18n()
const value = ref('')
const open = ref(false)
const pending = ref<PendingAttachment[]>([])
const fileInput = ref<HTMLInputElement | null>(null)

const options = computed(() => props.cores)

const selectedLabel = computed(() => {
  const option = options.value.find((item) => item.code === props.coreCode)
  return option?.label ?? props.coreCode
})

function select(code: string): void {
  emit('coreChange', code)
  open.value = false
}

function openFilePicker(): void {
  fileInput.value?.click()
}

function onFilesSelected(event: Event): void {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  for (const file of files) {
    const kind: MessageAttachment['kind'] = file.type.startsWith('image/') ? 'image' : 'file'
    pending.value.push({
      id: `${Date.now()}-${file.name}`,
      file,
      previewUrl: kind === 'image' ? URL.createObjectURL(file) : '',
      kind
    })
  }
}

function removePending(id: string): void {
  const item = pending.value.find((entry) => entry.id === id)
  if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl)
  pending.value = pending.value.filter((entry) => entry.id !== id)
}

function submit(): void {
  if (props.disabled || props.sending) return
  const text = value.value.trim()
  if (!text && pending.value.length === 0) return
  emit('send', {
    message: text,
    files: pending.value.map((item) => item.file)
  })
  value.value = ''
  for (const item of pending.value) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl)
  }
  pending.value = []
}
</script>

<template>
  <div class="border-t border-border px-4 py-4 sm:px-6">
    <div
      class="mx-auto w-full max-w-3xl rounded-[22px] bg-gradient-to-b from-border/70 to-border/30 p-px"
    >
      <div class="rounded-[20px] border border-border/60 bg-card shadow-sm">
        <div v-if="pending.length" class="flex flex-wrap gap-2 px-4 pt-3">
          <div
            v-for="item in pending"
            :key="item.id"
            class="relative overflow-hidden rounded-lg border border-border bg-muted/40"
          >
            <img
              v-if="item.kind === 'image'"
              :src="item.previewUrl"
              :alt="item.file.name"
              class="size-16 object-cover"
            />
            <div
              v-else
              class="flex size-16 flex-col items-center justify-center gap-1 px-1 text-center text-[10px] text-muted-foreground"
            >
              <svg viewBox="0 0 24 24" class="size-4 shrink-0" aria-hidden fill="none">
                <path
                  d="M7 4h7l5 5v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z"
                  stroke="currentColor"
                  stroke-width="1.5"
                />
                <path d="M14 4v5h5" stroke="currentColor" stroke-width="1.5" />
              </svg>
              <span class="line-clamp-2 w-full break-all">{{ item.file.name }}</span>
            </div>
            <button
              type="button"
              class="absolute right-1 top-1 rounded-full bg-background/80 px-1 text-xs"
              @click="removePending(item.id)"
            >
              ×
            </button>
          </div>
        </div>

        <textarea
          v-model="value"
          :disabled="disabled || sending"
          :placeholder="t('workspace.composer.placeholder')"
          class="min-h-24 w-full resize-none rounded-[20px] bg-transparent px-4 pt-4 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
          @keydown.enter.exact.prevent="submit()"
        />
        <div class="flex items-center justify-between gap-2 px-3 pb-3">
          <div class="relative flex items-center gap-2">
            <input ref="fileInput" type="file" multiple class="hidden" @change="onFilesSelected" />
            <AttachmentPickerButton
              :disabled="disabled || sending"
              :title="t('workspace.composer.addAttachment')"
              @click="openFilePicker"
            />

            <Button
              type="button"
              variant="ghost"
              size="sm"
              :disabled="disabled || sending || options.length === 0"
              class="h-8 max-w-44 shrink-0 justify-between gap-1 px-2 text-muted-foreground hover:text-foreground"
              @click="open = !open"
            >
              <span class="truncate text-xs">{{ selectedLabel }}</span>
              <svg viewBox="0 0 16 16" class="size-3 shrink-0" aria-hidden>
                <path
                  d="M4 6l4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </Button>

            <div
              v-if="open"
              class="absolute bottom-full left-0 z-20 mb-2 min-w-52 rounded-lg border border-border bg-card p-1 shadow-lg"
            >
              <button
                v-for="option in options"
                :key="option.code"
                type="button"
                :class="
                  cn(
                    'flex w-full flex-col rounded-md px-3 py-2 text-left hover:bg-muted',
                    option.code === coreCode && 'bg-muted',
                    !option.available && 'opacity-60'
                  )
                "
                :disabled="!option.available"
                @click="select(option.code)"
              >
                <span class="text-sm font-medium">{{ option.label }}</span>
                <span v-if="option.reason" class="text-xs text-muted-foreground">
                  {{ option.reason }}
                </span>
              </button>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            :disabled="disabled || sending || (!value.trim() && pending.length === 0)"
            :class="cn('size-9 rounded-full px-0')"
            :aria-label="t('workspace.composer.send')"
            @click="submit()"
          >
            <svg viewBox="0 0 24 24" class="size-4" aria-hidden fill="none">
              <path
                d="M12 5v14M5 12l7-7 7 7"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>
