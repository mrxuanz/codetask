import { nextTick, ref, type Ref } from 'vue'

export function useStickToBottom(
  scrollRoot: Ref<HTMLElement | null>,
  threshold = 96
): {
  stick: Ref<boolean>
  onScroll: () => void
  scrollToBottom: (behavior?: ScrollBehavior) => Promise<void>
  stickToBottomIfNeeded: (behavior?: ScrollBehavior) => Promise<void>
} {
  const stick = ref(true)

  function onScroll(): void {
    const el = scrollRoot.value
    if (!el) return
    stick.value = el.scrollHeight - el.scrollTop - el.clientHeight <= threshold
  }

  async function scrollToBottom(behavior: ScrollBehavior = 'auto'): Promise<void> {
    await nextTick()
    const el = scrollRoot.value
    if (!el) return
    el.scrollTo({ top: el.scrollHeight, behavior })
  }

  async function stickToBottomIfNeeded(behavior: ScrollBehavior = 'auto'): Promise<void> {
    if (!stick.value) return
    await scrollToBottom(behavior)
  }

  return { stick, onScroll, scrollToBottom, stickToBottomIfNeeded }
}
