<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff } from 'lucide-vue-next'
import Input from '@renderer/components/ui/Input.vue'

defineProps<{
  id?: string
  modelValue?: string
  placeholder?: string
  autocomplete?: string
  required?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  blur: []
}>()

const { t } = useI18n()
const visible = ref(false)

function toggleVisible(): void {
  visible.value = !visible.value
}
</script>

<template>
  <div class="relative">
    <Input
      :id="id"
      :model-value="modelValue"
      :type="visible ? 'text' : 'password'"
      :placeholder="placeholder"
      :autocomplete="autocomplete"
      :required="required"
      class="pr-10"
      @update:model-value="emit('update:modelValue', $event)"
      @blur="emit('blur')"
    />
    <button
      type="button"
      class="absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
      :aria-label="visible ? t('common.hidePassword') : t('common.showPassword')"
      @click="toggleVisible"
    >
      <EyeOff v-if="visible" class="size-4" aria-hidden="true" />
      <Eye v-else class="size-4" aria-hidden="true" />
    </button>
  </div>
</template>
