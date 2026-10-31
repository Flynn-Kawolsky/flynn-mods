import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Buddy, Mem, Mood } from '../types'

const PANE = 'flynn-buddy'
const BACKGROUND = new Set(['Agent', 'Workflow'])
const MEM0: Mem = { ok: null, version: '', updateChecked: '', projects: [], recent24: 0, latest: '', reads: 0, writes: 0, errors: 0, lastMs: 0, checkedAt: 0 }
const buddy = atom({ plugin: 'flynn-buddy', key: 'buddy' } as const, { mood: 'calm', running: 0, note: '', pct: 0, left: 0, mem: MEM0 } as Buddy, {
  shape: 'buddy-3',
})

// Basic Memory: the engine's own MCP connection, read-only calls. Tool calls of this session are counted as they pass.
const BM = 'basic-memory'
const BM_TOOL = 'mcp__basic-memory__'
const BM_WRITES = new Set(['write_note', 'edit_note', 'delete_note', 'move_note', 'create_memory_project', 'delete_project'])
const BM_EVERY_MS = 5 * 60 * 1000
async function bmCall($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<any> {
  const r = await $.mcp.call(BM, tool, args)
  const text = r.content?.find(c => c.type === 'text')?.text ?? ''
  if (r.isError) throw new Error(text)
  try {
    const j = JSON.parse(text)
    return j?.result ?? j
  } catch {
    return text
  }
}
// One probe: projects and their note counts, 24h activity, latest note; the version only once per session.
async function probeMemory($: EngineInterface, mem: Mem): Promise<Mem> {
  const t0 = await $.clock.now()
  try {
    const list = await bmCall($, 'list_memory_projects', { output_format: 'json' })
    const names: string[] = (list.projects ?? []).map((p: { name: string }) => p.name)
    const projects = await Promise.all(names.map(async name => ({ name, notes: (await bmCall($, 'find', { path: `${name}/`, name: '*.md', page_size: 1 })).total ?? 0 })))
    const recent = await Promise.all(names.map(name => bmCall($, 'recent_activity', { project: name, timeframe: '24h', output_format: 'json', page_size: 100 })))
    const items = recent.flatMap(r => (Array.isArray(r) ? r : []))
    let { version, updateChecked } = mem
    if (version === '') {
      const diag = String(await bmCall($, 'basic_memory_diagnostics', {}))
      version = diag.match(/basic-memory:\s*([\d.]+)/)?.[1] ?? '?'
      updateChecked = diag.match(/"auto_update_last_checked_at":\s*"([\d-]+)/)?.[1] ?? ''
    }
    return { ...mem, ok: true, version, updateChecked, projects, recent24: items.length, latest: items[0]?.title ?? '', lastMs: (await $.clock.now()) - t0, checkedAt: await $.clock.now() }
  } catch {
    return { ...mem, ok: false, lastMs: (await $.clock.now()) - t0, checkedAt: await $.clock.now() }
  }
}

type Row = { id: string; day: string; tokens: number; usd: number }

// Original pixel owl: shapes in a 32-unit space sampled on an N×N grid, so the eyes can change per mood; light from the top left.
// Layers animate separately (SMIL): the body breathes, bobs and blinks, wings flap, the whole bird paces (turning round) or shivers.
const N = 768
const RES = N / 32
const PAL = {
  K: '#3b2414', B: '#8a5a32', H: '#a36d3e', S: '#6f4628', L: '#6e4424', F: '#a8743f', FD: '#b07c48', C: '#f2deb0', CH: '#fbedcf', CS: '#dec493',
  D: '#c49360', W: '#ffffff', P: '#1b1b1b', Y: '#e9a23b', YH: '#f6c063', YK: '#a8641a', BL: '#ec9a82',
}
type Grid = (string | undefined)[][]
const EYES = [11.5, 20.5]
const EY = 12
const grid = (paint: (x: number, y: number) => string | undefined): Grid =>
  Array.from({ length: N }, (_, y) => Array.from({ length: N }, (_, x) => paint((x + 0.5) / RES, (y + 0.5) / RES)))
const inEllipse = (x: number, y: number, cx: number, cy: number, rx: number, ry: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1
const dist = (x: number, y: number, cx: number, cy: number) => Math.hypot(x - cx, y - cy)
// Edge `width` units thick wherever a filled pixel lies that close to empty space.
const outline = (g: Grid, ink = PAL.K, width = 0.6): Grid => {
  const edge = (x: number, y: number) => {
    for (let k = 1; k <= Math.round(RES * width); k++) if (!g[y + k]?.[x] || !g[y - k]?.[x] || !g[y][x + k] || !g[y][x - k]) return true
    return false
  }
  return g.map((row, y) => row.map((c, x) => (c && edge(x, y) ? ink : c)))
}
// Three tones from a top-left light over an ellipse: highlight, base, shadow.
const shade = (x: number, y: number, cx: number, cy: number, rx: number, ry: number, [hi, base, lo]: string[]) => {
  const light = -(((x - cx) / rx) * 0.55 + ((y - cy) / ry) * 0.85)
  return light > 0.5 ? hi : light < -0.55 ? lo : base
}

function eye(mood: Mood, x: number, y: number, ex: number): string | undefined {
  const d = dist(x, y, ex, EY)
  if (d > 4.8) return undefined
  const inward = (x - ex) * (ex < 16 ? 1 : -1)
  switch (mood) {
    case 'done':
      return d > 4 ? PAL.B : Math.abs(dist(x, y, ex, EY + 1.5) - 2.7) < 0.6 && y < EY + 1 ? PAL.P : PAL.B
    case 'busy':
      if (y < EY - 1.5) return PAL.B
      if (y < EY - 0.5) return PAL.K
      break
    case 'frown': {
      const brow = EY - 2 + inward * 0.7
      if (y < brow - 0.8) return PAL.B
      if (y < brow + 0.4) return PAL.K
      break
    }
  }
  if (d > 4) return PAL.K
  const pupil = { calm: [ex, EY, 3], tense: [ex, EY, 1.5], busy: [ex + 1.3, EY + 0.3, 2.4], frown: [ex, EY + 1, 2.4], done: [ex, EY, 0] }[mood]
  if (mood === 'calm' && (dist(x, y, ex - 1.2, EY - 1.2) < 0.9 || dist(x, y, ex + 1.1, EY + 1.1) < 0.4)) return PAL.W
  return dist(x, y, pupil[0], pupil[1]) <= pupil[2] ? PAL.P : PAL.W
}

// Small V marks on the belly, staggered every other row of 3-unit cells.
function chevron(x: number, y: number): boolean {
  const lx = (((x - 16 + 1.5 * (Math.floor(y / 3) % 2)) % 3) + 3) % 3 - 1.5
  return Math.abs(lx) < 1.1 && Math.abs((y % 3) - (1 + Math.abs(lx) * 0.6)) < 0.3
}

function layers(mood: Mood) {
  const body = outline(grid((x, y) => {
    const tuft = y >= 3 && y <= 9 && ((x >= 6 && x <= 6 + (y - 3) * 0.8) || (x <= 26 && x >= 26 - (y - 3) * 0.8))
    return inEllipse(x, y, 16, 17.5, 11, 12) || tuft ? PAL.B : undefined
  })).map((row, y) => row.map((c, x) => {
    if (c !== PAL.B) return c
    const [px, py] = [(x + 0.5) / RES, (y + 0.5) / RES]
    const e = eye(mood, px, py, EYES[0]) ?? eye(mood, px, py, EYES[1])
    if (e) return e
    if (py >= 15 && py < 20 && Math.abs(px - 16) <= (20 - py) * 0.45 + 0.3) return px < 15.6 ? PAL.YH : PAL.Y
    if (mood === 'done' && EYES.some(ex => inEllipse(px, py, ex + (ex < 16 ? -1.6 : 1.6), EY + 3.6, 1.5, 0.75))) return PAL.BL
    if (inEllipse(px, py, 16, 22, 7, 7.5)) return chevron(px, py) ? PAL.D : shade(px, py, 16, 22, 7, 7.5, [PAL.CH, PAL.C, PAL.CS])
    if (EYES.some(ex => dist(px, py, ex, EY) <= 5.7)) return PAL.FD
    return shade(px, py, 16, 17.5, 11, 12, [PAL.H, PAL.B, PAL.S])
  }))
  // Wing: lighter coverts at the shoulder, then curved flight-feather bands.
  const wing = (cx: number) => outline(grid((x, y) => {
    if (!inEllipse(x, y, cx, 19.5, 3, 7)) return undefined
    if (y < 16) return dist(x, y, cx, 14) < 1.4 ? PAL.H : PAL.F
    return (y + Math.abs(x - cx) * 0.6) % 2.4 < 0.6 ? PAL.F : PAL.L
  }))
  // Feet: three rounded toes each, inked in a darker orange.
  const feet = outline(grid((x, y) => ([12.5, 19.5].some(fx => [-1.1, 0, 1.1].some(t => inEllipse(x, y, fx + t, 30.6, 0.55, 1.1))) ? (x % 1 < 0.4 ? PAL.YH : PAL.Y) : undefined)), PAL.YK, 0.3)
  // Lids close along a slight smile curve.
  const lids = grid((x, y) => {
    const ex = EYES.find(e => dist(x, y, e, EY) <= 4)
    return ex === undefined ? undefined : Math.abs(y - (EY + 0.3 - (x - ex) ** 2 * 0.08)) < 0.35 ? PAL.K : PAL.B
  })
  return { body, left: wing(6.5), right: wing(25.5), feet, lids }
}

// Each horizontal run is a stroke two rows tall (rows overlap so sub-pixel rows do not fade); one path per colour with relative moves keeps the SVG under the host's
// 131072-char cap. The group scales the 32-unit owl into place at (4, 4) in a 40×36 box.
function rects(g: Grid, ox = 4, oy = 4): string {
  const paths = new Map<string, { d: string; x: number; y: number }>()
  g.forEach((row, y) => {
    for (let x = 0; x < row.length; ) {
      let end = x + 1
      while (end < row.length && row[end] === row[x]) end++
      const c = row[x]
      if (c) {
        const p = paths.get(c)
        const step = p ? `m${x - p.x} ${y - p.y}h${end - x}` : `M${x} ${y}h${end - x}`
        paths.set(c, { d: (p?.d ?? '') + step, x: end, y })
      }
      x = end
    }
  })
  const body = [...paths].map(([c, p]) => `<path stroke="${c}" d="${p.d}"/>`).join('')
  return `<g fill="none" stroke-width="2" transform="translate(${ox} ${oy}) scale(${1 / RES}) translate(0 0.5)">${body}</g>`
}

const spin = (deg: number[], pivot: string, dur: number, times?: string) =>
  `<animateTransform attributeName="transform" type="rotate" values="${deg.map(d => `${d} ${pivot}`).join(';')}"${times ? ` keyTimes="${times}"` : ''} dur="${dur}s" repeatCount="indefinite"/>`
const move = (values: string, dur: number, discrete = false) =>
  `<animateTransform attributeName="transform" type="translate" values="${values}"${discrete ? ' calcMode="discrete"' : ''} dur="${dur}s" repeatCount="indefinite"/>`
const blink = (dur: number) => `<animate attributeName="opacity" values="0;1;0" keyTimes="0;0.94;0.97" calcMode="discrete" dur="${dur}s" repeatCount="indefinite"/>`
const scale = (values: string, dur: number, discrete = false) =>
  `<animateTransform attributeName="transform" type="scale" values="${values}"${discrete ? ' calcMode="discrete"' : ''} dur="${dur}s" repeatCount="indefinite"/>`
// Runs `anim` about (x, y) instead of the origin.
const about = (x: number, y: number, anim: string, inner: string) =>
  `<g transform="translate(${x} ${y})"><g>${anim}<g transform="translate(${-x} ${-y})">${inner}</g></g></g>`
type Motion = { walk: string; bob: string; flap: number[]; flapDur: number; flapTimes?: string; blink: number; tilt?: string; turn?: boolean; hop?: boolean }
const MOTION: Record<Mood, Motion> = {
  calm: { walk: '', bob: move('0 0;0 -1', 2.4, true), flap: [0, 0, 18, 0, 18, 0], flapDur: 7, flapTimes: '0;0.8;0.84;0.88;0.92;1', blink: 4, tilt: spin([0, 0, 5, 5, 0, 0], '20 33', 9, '0;0.45;0.5;0.75;0.8;1') },
  tense: { walk: '<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0.4 0;-0.4 0;0.4 0;0 0" keyTimes="0;0.7;0.76;0.82;0.88;1" dur="3s" repeatCount="indefinite"/>', bob: '', flap: [], flapDur: 0, blink: 2.5 },
  busy: { walk: move('-3 0;3 0;-3 0', 4), bob: move('0 0;0 -1', 0.5, true), flap: [], flapDur: 0, blink: 0, turn: true },
  frown: { walk: '', bob: move('0 0;0 -1', 3.2, true), flap: [], flapDur: 0, blink: 5 },
  done: { walk: '', bob: move('0 0;0 -2', 1.2, true), flap: [0, 35, 0, 35, 0, 0], flapDur: 3, flapTimes: '0;0.08;0.16;0.24;0.32;1', blink: 0, hop: true },
}
// Mood marks in the top-right margin: smooth vectors (not pixels) so they stay legible at band size.
const ink = (d: string, fill: string, dark: string, w = 1.4) =>
  `<path d="${d}" fill="none" stroke="${dark}" stroke-width="${w + 0.7}" stroke-linecap="round" stroke-linejoin="round"/><path d="${d}" fill="none" stroke="${fill}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`
const MARKS: Record<Mood, string> = {
  calm: '',
  tense: '<g><animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 3" keyTimes="0;0.6;1" dur="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;1;0" keyTimes="0;0.6;1" dur="1.8s" repeatCount="indefinite"/>'
    + '<path d="M36 0.6C36 0.6 33.4 4.2 33.4 6.3A2.6 2.6 0 0 0 38.6 6.3C38.6 4.2 36 0.6 36 0.6Z" fill="#8fd0f0" stroke="#3a86b8" stroke-width="0.45" stroke-linejoin="round"/>'
    + '<ellipse cx="35" cy="6" rx="0.5" ry="0.85" fill="#ffffff" opacity="0.9"/></g>',
  busy: [32.8, 35.6, 38.4].map((cx, i) =>
    `<circle cx="${cx}" cy="3" r="1" fill="#8a8a8a" stroke="#555555" stroke-width="0.35"><animate attributeName="opacity" values="0.25;1;0.25" dur="1.2s" begin="${i * 0.3}s" repeatCount="indefinite"/></circle>`).join(''),
  frown: ink('M33.2 1.2L38.4 6.4M38.4 1.2L33.2 6.4', '#e0533f', '#8e2a22'),
  done: ink('M32.6 4.4L34.7 6.8L38.6 1.4', '#35b07a', '#1f6b4a'),
}
const DRAWN = new Map<Mood, string>()
function owl(mood: Mood): string {
  const hit = DRAWN.get(mood)
  if (hit) return hit
  const l = layers(mood)
  const m = MOTION[mood]
  const wing = (g: Grid, pivot: string, sign: number) =>
    `<g>${m.flap.length ? spin(m.flap.map(d => d * sign), pivot, m.flapDur, m.flapTimes) : ''}${rects(g)}</g>`
  const lids = m.blink ? `<g opacity="0">${blink(m.blink)}${rects(l.lids)}</g>` : ''
  const torso = `${rects(l.body)}${lids}${wing(l.left, '10.5 17', 1)}${wing(l.right, '29.5 17', -1)}`
  const breathing = about(20, 33, scale('1 1;1.015 1.025;1 1', 3), m.tilt ? `<g>${m.tilt}${torso}</g>` : torso)
  const feet = rects(l.feet)
  const bird = m.hop ? `<g>${m.bob}${feet}${breathing}</g>` : `${feet}<g>${m.bob}${breathing}</g>`
  // Pacing: face right on the way out, flip to face left on the way back.
  const walker = m.turn ? about(20, 0, scale('1 1;-1 1', 4, true), bird) : bird
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 36"><g>${m.walk}${walker}</g><g shape-rendering="geometricPrecision">${MARKS[mood]}</g></svg>`
  DRAWN.set(mood, svg)
  return svg
}

const LABEL: Record<Mood, string> = {
  calm: '輕鬆', tense: '對話快滿了', busy: '背景派工中', frown: '工具失敗或被擋', done: '這回合收好了',
}
const TONE: Record<Mood, 'warning' | 'suggestion' | 'error' | 'success' | undefined> = {
  calm: undefined, tense: 'warning', busy: 'suggestion', frown: 'error', done: 'success',
}
// Usage bar 48×6; amber from 70%, red from 85%. The track is translucent grey so it reads on light and dark themes.
const bar = (pct: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 6"><rect width="48" height="6" rx="3" fill="#8a8a8a" fill-opacity="0.35"/><rect width="${Math.max(3, Math.min(48, pct * 0.48))}" height="6" rx="3" fill="${pct >= 85 ? '#b93a32' : pct >= 70 ? '#c87a28' : '#8a5a32'}"/></svg>`
// Basic Memory lamp: green when the last probe answered, red when it failed, grey before the first probe.
const lamp = (ok: boolean | null) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="${ok === true ? '#4eaa7a' : ok === false ? '#d95d5d' : '#8a8a8a'}"/></svg>`
const DIVIDER = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 40"><rect width="1" height="40" fill="#8a8a8a" fill-opacity="0.4"/></svg>'
const total = (m: Mem) => m.projects.reduce((n, p) => n + p.notes, 0)
const MEM_STATE = (m: Mem) => (m.ok === true ? '正常' : m.ok === false ? '連線失敗' : '尚未讀取')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'buddy', description: '打開墨墨面板（最近各場成本）' })
    return next(e)
  })

  on('command.run', { command: 'buddy' }, async $ => {
    await $.ui.open({ id: PANE, title: '墨墨' })
    return { text: '墨墨面板已打開。' }
  })

  // Bookkeeping only, not a guard: if it throws, the tool's own result stands.
  on('tool.call', async ($, e, next) => {
    const isBackground = BACKGROUND.has(e.tool)
    const bmTool = e.tool.startsWith(BM_TOOL) ? e.tool.slice(BM_TOOL.length) : ''
    if (isBackground) await update($, buddy, b => ({ ...b, running: b.running + 1, mood: 'busy' }))
    const t0 = bmTool ? await $.clock.now() : 0
    const ran = await next(e)
    if (isBackground) await update($, buddy, b => ({ ...b, running: Math.max(0, b.running - 1) }))
    if (bmTool) {
      const ms = (await $.clock.now()) - t0
      const failed = ran.deny !== undefined || ran.isError === true
      const write = BM_WRITES.has(bmTool)
      await update($, buddy, b => ({
        ...b,
        mem: { ...b.mem, reads: b.mem.reads + (write ? 0 : 1), writes: b.mem.writes + (write ? 1 : 0), errors: b.mem.errors + (failed ? 1 : 0), lastMs: ms },
      }))
    }
    if (ran.deny !== undefined || ran.isError === true)
      await update($, buddy, b => ({ ...b, mood: 'frown', note: `${e.tool} ${ran.deny ? '被擋' : '失敗'}` }))
    return ran
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const out = await next(e)
    // The compaction window (rawMaxTokens) is what the app's context meter shows; `window` is the model's larger one.
    const u = await $.session.usage({ breakdown: 'summary' })
    const bd = u.context.breakdown
    const used = u.context.tokens ?? bd?.totalTokens ?? 0
    const max = bd?.rawMaxTokens ?? u.context.window
    const limit = bd?.isAutoCompactEnabled && bd.autoCompactThreshold ? bd.autoCompactThreshold : max
    const pct = Math.round((used / max) * 100)
    const left = Math.max(0, limit - used)
    const id = await $.session.id()
    const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
    await $.store.set(`row:${id}`, { id, day, tokens: u.context.tokens ?? 0, usd: u.cost?.usd ?? 0 } satisfies Row)
    const before = await read($, buddy)
    const mem = (await $.clock.now()) - before.mem.checkedAt >= BM_EVERY_MS ? await probeMemory($, before.mem) : before.mem
    await update($, buddy, b => ({
      ...b,
      pct,
      left,
      mem,
      mood: used >= limit * 0.7 ? 'tense' : b.running > 0 ? 'busy' : b.mood === 'frown' ? 'frown' : 'done',
    }))
    return out
  })

  on('turn.start', async ($, e, next) => {
    await update($, buddy, b => ({ ...b, mood: b.running > 0 ? 'busy' : 'calm', note: '' }))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Svg } = $.ui.resolve(e)
    const b = await read($, buddy)
    const m = b.mem
    const u = await $.session.usage()
    const keys = (await $.store.keys()).filter(k => k.startsWith('row:'))
    const rows = (await Promise.all(keys.map(k => $.store.get(k)))) as Row[]
    rows.sort((a, c) => (a.day < c.day ? 1 : -1))
    return (
      <Box flexDirection="column">
        {Svg ? <Svg source={owl(b.mood)} alt={`墨墨：${LABEL[b.mood]}`} width={240} height={216} isInteractive /> : <Text>（墨墨：{LABEL[b.mood]}）</Text>}
        <Text bold>{LABEL[b.mood]}</Text>
        {b.note !== '' && <Text dimColor>{b.note}</Text>}
        <Text>對話用量 {b.pct}%（距自動壓縮 {Math.round(b.left / 1000)}k）</Text>
        <Text>本場成本 ${(u.cost?.usd ?? 0).toFixed(2)}；背景派工 {b.running}</Text>
        <Text bold>Basic Memory</Text>
        <Box flexDirection="row" alignItems="center" gap="xs">
          {Svg && <Svg source={lamp(m.ok)} alt={`連線${MEM_STATE(m)}`} width={8} height={8} />}
          <Text color={m.ok === false ? 'error' : undefined}>連線{MEM_STATE(m)}</Text>
          {m.lastMs > 0 && <Text dimColor tabular>· 上次 {(m.lastMs / 1000).toFixed(1)} 秒</Text>}
        </Box>
        <Text tabular>筆記 {m.ok === true ? total(m) : '—'} 則</Text>
        {m.projects.length > 1 && <Text dimColor tabular>{m.projects.map(p => `${p.name} ${p.notes}`).join(' · ')}</Text>}
        <Text tabular>24 小時新增或修改 {m.recent24} 則</Text>
        {m.latest !== '' && <Text dimColor>最新：{m.latest}</Text>}
        <Box flexDirection="row" gap="xs">
          <Text tabular>本場 讀 {m.reads} · 寫 {m.writes} ·</Text>
          <Text tabular color={m.errors > 0 ? 'error' : undefined} dimColor={m.errors === 0}>錯誤 {m.errors}</Text>
        </Box>
        <Text dimColor tabular>版本 {m.version === '' ? '—' : `v${m.version}`}{m.updateChecked !== '' ? ` · 上次查更新 ${m.updateChecked}` : ''}</Text>
        <Text bold>最近各場</Text>
        {rows.slice(0, 10).map(r => (
          <Text dimColor>{r.day}  {r.id.slice(0, 8)}  ${r.usd.toFixed(2)}</Text>
        ))}
      </Box>
    )
  })
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Svg } = $.ui.resolve(e)
    const b = await read($, buddy)
    const m = b.mem
    const u = await $.session.usage()
    return (
      <Box flexDirection="row" alignItems="center" gap="sm">
        {Svg && <Svg source={owl(b.mood)} alt={`墨墨：${LABEL[b.mood]}`} width={80} height={72} isInteractive />}
        <Box flexDirection="column" gap="xs">
          <Text weight="semibold" color={TONE[b.mood]}>
            {b.mood === 'frown' && b.note !== '' ? b.note : `${LABEL[b.mood]}${b.note !== '' ? ` · ${b.note}` : ''}`}
          </Text>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {Svg && <Svg source={bar(b.pct)} alt={`用量 ${b.pct}%`} width={48} height={6} />}
            <Text dimColor tabular>
              用量 {b.pct}% · 餘 {Math.round(b.left / 1000)}k · 花費 ${(u.cost?.usd ?? 0).toFixed(2)}{b.running > 0 ? ` · 背景 ${b.running}` : ''}
            </Text>
          </Box>
        </Box>
        {Svg && <Svg source={DIVIDER} alt="" width={1} height={40} />}
        <Box flexDirection="column" gap="xs">
          <Box flexDirection="row" alignItems="center" gap="xs">
            {Svg && <Svg source={lamp(m.ok)} alt={`Basic Memory ${MEM_STATE(m)}`} width={8} height={8} />}
            <Text weight="medium" color={m.ok === false ? 'error' : undefined}>
              Basic Memory{m.ok === true ? '' : ` ${MEM_STATE(m)}`}
            </Text>
          </Box>
          <Text dimColor tabular>
            {m.ok === true ? total(m) : '—'} 則 · 讀 {m.reads} 寫 {m.writes} · {m.version === '' ? 'v—' : `v${m.version}`}
          </Text>
        </Box>
      </Box>
    )
  })

}
