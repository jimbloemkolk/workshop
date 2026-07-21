/** Runs `fn` immediately, then every `intervalMs`, forever. A collector
 * throwing (source down, parse error, etc.) is swallowed and logged rather
 * than killing the loop — the whole point of these collectors is that a
 * flaky source degrades its own section, not the process. */
export function startPolling(name: string, intervalMs: number, fn: () => Promise<void>): void {
  const tick = async () => {
    try {
      await fn()
    } catch (err) {
      console.warn(`[${name}] poll failed: ${(err as Error).message}`)
    }
  }
  void tick()
  setInterval(() => void tick(), intervalMs)
}
