export function createAsyncQueue<T>(): {
  push: (value: T) => void
  fail: (error: unknown) => void
  close: () => void
  iterate: () => AsyncGenerator<T>
} {
  const values: T[] = []
  const waiters: Array<(result: IteratorResult<T>) => void> = []
  let closed = false
  let failure: unknown

  function flushWaiter(result: IteratorResult<T>): void {
    const waiter = waiters.shift()
    if (waiter) waiter(result)
  }

  function push(value: T): void {
    if (closed || failure) return
    const waiter = waiters.shift()
    if (waiter) {
      waiter({ value, done: false })
      return
    }
    values.push(value)
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
        throw failure instanceof Error ? failure : new Error(String(failure))
      }
      if (values.length) {
        yield values.shift() as T
        continue
      }
      if (closed) return
      const next = await new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve)
      })
      if (next.done) return
      yield next.value as T
    }
  }

  return { push, fail, close, iterate }
}
