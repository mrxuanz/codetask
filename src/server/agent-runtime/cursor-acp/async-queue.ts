export interface AsyncQueueOptions {
  softMax?: number
  hardMax?: number
  onHighWater?: () => void
}

export const ASYNC_QUEUE_OVERFLOW_ERROR = new Error('async queue overflow')

export function createAsyncQueue<T>(options?: AsyncQueueOptions): {
  push: (value: T) => void
  fail: (error: unknown) => void
  close: () => void
  iterate: () => AsyncGenerator<T>
} {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: unknown
  let highWaterNotified = false

  function flushWaiter(result: IteratorResult<T>): void {
    const waiter = waiters.shift()
    if (waiter) waiter(result)
  }

  function throwFailure(): never {
    throw failure instanceof Error ? failure : new Error(String(failure))
  }

  function maybeNotifyHighWater(): void {
    const softMax = options?.softMax
    if (softMax === undefined) return
    if (values.length > softMax) {
      if (!highWaterNotified) {
        highWaterNotified = true
        options?.onHighWater?.()
      }
      return
    }
    highWaterNotified = false
  }

  function push(value: T): void {
    if (closed || failure) return
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    if (options?.hardMax !== undefined && values.length >= options.hardMax) {
      fail(ASYNC_QUEUE_OVERFLOW_ERROR)
      return
    }
    values.push(value)
    maybeNotifyHighWater()
  }

  function fail(error: unknown): void {
    if (closed || failure) return
    failure = error
    while (waiters.length) {
      flushWaiter({ value: undefined as T, done: true })
    }
  }

  function close(): void {
    if (closed || failure) return
    closed = true
    while (waiters.length) {
      flushWaiter({ value: undefined as T, done: true })
    }
  }

  async function* iterate(): AsyncGenerator<T> {
    while (true) {
      if (failure) {
        throwFailure()
      }
      if (values.length) {
        yield values.shift() as T
        maybeNotifyHighWater()
        continue
      }
      if (closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve)
      })
      if (next.done) {
        if (failure) throwFailure()
        return
      }
      yield next.value as T
    }
  }

  return { push, fail, close, iterate }
}
