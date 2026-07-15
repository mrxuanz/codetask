import { toast as sonnerToast } from 'vue-sonner'

/** Global operation feedback (success / error / warning / info). */
export const toast = {
  message: (message: string) => sonnerToast(message),
  success: (message: string) => sonnerToast.success(message),
  error: (message: string) => sonnerToast.error(message),
  warning: (message: string) => sonnerToast.warning(message),
  info: (message: string) => sonnerToast.info(message),
  dismiss: (id?: string | number) => sonnerToast.dismiss(id)
}

export function toastError(err: unknown, fallback: string): void {
  toast.error(err instanceof Error ? err.message : fallback)
}
