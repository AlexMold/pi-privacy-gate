export function retry<T>(fn: () => Promise<T>, attempts: number, delayMs: number): Promise<T> {
  let lastError: unknown;
  return (async () => {
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastError = e;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  })();
}
