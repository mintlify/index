export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  makeTimeoutError: (ms: number) => Error = (timeoutMs) => new TimeoutError(timeoutMs)
): Promise<T> {
  let timerId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => reject(makeTimeoutError(ms)), ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timerId)), timeout]);
}
