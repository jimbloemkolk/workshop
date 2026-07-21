/** Tiny persisted user-settings store — one JSON blob in localStorage.
 * This is the future home of user-facing settings in general: today
 * `keepScreenOn` is set programmatically (no UI edits it yet), but a
 * settings screen down the line would just call `updateSettings` the same
 * way. Deliberately lean: no framework, no schema migration machinery —
 * add fields to `Settings`/`DEFAULTS` as they're needed. */

export interface Settings {
  /** Request a screen wake lock for the duration of a call, so the phone's
   * own idle-timeout auto-lock doesn't kill the microphone mid-conversation.
   * Defaults on — this is a correctness fix, not an opt-in feature. */
  keepScreenOn: boolean
}

const STORAGE_KEY = 'harvester.settings'

const DEFAULTS: Settings = {
  keepScreenOn: true,
}

export function getSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    // Private-browsing localStorage throws, or the stored JSON is garbage —
    // either way, defaults are a safe fallback, never a crash.
    return { ...DEFAULTS }
  }
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
  return next
}
