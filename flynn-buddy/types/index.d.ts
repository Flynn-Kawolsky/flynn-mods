export type Mood = 'calm' | 'tense' | 'busy' | 'frown' | 'done'
export type Mem = {
  ok: boolean | null
  version: string
  updateChecked: string
  projects: { name: string; notes: number }[]
  recent24: number
  latest: string
  reads: number
  writes: number
  errors: number
  lastMs: number
  checkedAt: number
}
export type Buddy = { mood: Mood; running: number; note: string; pct: number; left: number; mem: Mem }

declare module 'claude-code' {
  interface PluginState {
    'flynn-buddy': { buddy: Shaped<Buddy> }
  }
}
