// 测试辅助：字节构建器 + 与两个 oracle（midi-file 原始事件 / @tonejs/midi 视图）的比较器。
// oracle 只在这里当裁判，绝不进运行时（差分纪律）。

import type { MidiEvent, ParsedSmf } from '../src/smf/types'

// ---------- 字节构建 ----------

export function u32(v: number): number[] {
  return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
}

export function varint(v: number): number[] {
  if (v < 0x80) return [v]
  const groups: number[] = []
  while (v > 0) { groups.push(v & 0x7f); v >>= 7 }
  const out: number[] = []
  for (let i = groups.length - 1; i >= 0; i--) out.push(i > 0 ? groups[i]! | 0x80 : groups[i]!)
  return out
}

/** delta + 原始事件字节 */
export function ev(delta: number, ...bytes: number[]): number[] {
  return [...varint(delta), ...bytes]
}

export function chunk(id: string, body: number[]): number[] {
  const idBytes = [...id].map(c => c.charCodeAt(0))
  if (idBytes.length !== 4) throw new Error('chunk id 必须 4 字节')
  return [...idBytes, ...u32(body.length), ...body]
}

/** MThd 块（division 默认 480） */
export function mthd(format: number, ntrks: number, division = 480): number[] {
  return chunk('MThd', [(format >> 8) & 255, format & 255, (ntrks >> 8) & 255, ntrks & 255, (division >> 8) & 255, division & 255])
}

export function mtrk(body: number[]): number[] {
  return chunk('MTrk', body)
}

export function smf(tracks: number[][], format = 1, division = 480): Uint8Array {
  return Uint8Array.from([...mthd(format, tracks.length, division), ...tracks.map(mtrk).flat()])
}

export function hex(s: string): number[] {
  return s.replace(/\s+/g, '').match(/../g)!.map(b => parseInt(b, 16))
}

// ---------- 我的 MidiEvent → 与 midi-file 原始事件可比的形态 ----------

/** mine → {tick, type, ...字段}；与 oracle 事件对齐（channel 事件字段名换成 oracle 命名） */
export function oracleShape(ev: MidiEvent): Record<string, unknown> {
  const out: Record<string, unknown> = { tick: ev.tick, type: ev.type }
  if (ev.channel !== undefined) out.channel = ev.channel
  const d = ev.data
  switch (ev.type) {
    case 'noteOff': case 'noteOn':
      out.noteNumber = d.key; out.velocity = d.velocity
      if (d.byte9 !== undefined) out.byte9 = d.byte9
      break
    case 'noteAftertouch':
      out.noteNumber = d.key; out.amount = d.amount
      break
    case 'controller':
      out.controllerType = d.controller; out.value = d.value
      break
    case 'programChange':
      out.programNumber = d.program
      break
    case 'channelAftertouch':
      out.amount = d.amount
      break
    case 'pitchBend':
      out.value = d.value
      break
    case 'channelPrefix':
      out.channel = d.channel
      break
    case 'portPrefix':
      out.port = d.port
      break
    case 'sequenceNumber':
      out.number = d.number
      break
    case 'setTempo':
      out.microsecondsPerBeat = d.microsecondsPerBeat
      break
    case 'smpteOffset':
      out.frameRate = d.frameRate; out.hour = d.hour; out.min = d.min; out.sec = d.sec
      out.frame = d.frame; out.subFrame = d.subFrame
      break
    case 'timeSignature':
      out.numerator = d.numerator; out.denominator = d.denominator
      out.metronome = d.metronome; out.thirtyseconds = d.thirtyseconds
      break
    case 'keySignature':
      out.key = d.key; out.scale = d.scale
      break
    case 'sysEx': case 'endSysEx': case 'sequencerSpecific':
      out.data = d.bytes // 双方都转 hex 后比较
      break
    case 'unknownMeta':
      out.metatypeByte = d.metatypeByte; out.data = d.bytes
      break
    case 'text': case 'copyrightNotice': case 'trackName': case 'instrumentName':
    case 'lyrics': case 'marker': case 'cuePoint':
      out.text = d.text
      break
    case 'endOfTrack':
      break
    default:
      throw new Error(`oracleShape：未知事件类型 ${ev.type}`)
  }
  return out
}

/** oracle 原始事件 → 可比形态（delta 累积为 tick；剔除解析伪影 running/meta 标记） */
export function oracleEventToShape(raw: Record<string, unknown>, tick: number): Record<string, unknown> {
  const { deltaTime: _d, running: _r, meta: _m, ...rest } = raw
  const out: Record<string, unknown> = { ...rest, tick }
  if ('data' in out && (Array.isArray(out.data) || ArrayBuffer.isView(out.data))) {
    const arr = Array.from(out.data as ArrayLike<number>)
    out.data = arr.map(b => (b < 16 ? '0' : '') + b.toString(16)).join('')
  }
  if (typeof out.byte9 === 'boolean') out.byte9 = out.byte9 ? 1 : 0  // oracle 用布尔，归一化为数字
  return out
}

/** 逐字段比较，返回不一致描述列表（空数组 = 全等） */
export function diffShapes(a: Record<string, unknown>, b: Record<string, unknown>, label: string): string[] {
  const problems: string[] = []
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    const av = a[k], bv = b[k]
    const bothHave = k in a && k in b
    if (!bothHave) {
      // byte9：仅在 mine 侧存在时跳过（velocity=0 的 noteOff，oracle 可能无此标记）
      if (k === 'byte9') continue
      problems.push(`${label}: 字段 '${k}' 只在单侧存在 (a=${JSON.stringify(av)} b=${JSON.stringify(bv)})`)
      continue
    }
    if (typeof av === 'number' && typeof bv === 'number') {
      if (!Object.is(av, bv)) problems.push(`${label}: 字段 '${k}' a=${av} b=${bv}`)
    } else if (av !== bv) {
      problems.push(`${label}: 字段 '${k}' a=${JSON.stringify(av)} b=${JSON.stringify(bv)}`)
    }
  }
  return problems
}

// ---------- 我的 ParsedSmf → @tonejs/midi 视图（按 tonejs 源码语义复刻） ----------

const KEY_SIG_KEYS = ['Cb', 'Gb', 'Db', 'Ab', 'Eb', 'Bb', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F#', 'C#']

/** 把我的解析结果复刻成 tonejs toJSON() 的形态（用于差分） */
export function mineToToneView(p: ParsedSmf): unknown {
  // ---- Header（按 tonejs 语义，在轨拆分之前的原始轨上收集） ----
  const tempos: { bpm: number; ticks: number }[] = []
  const timeSignatures: { ticks: number; timeSignature: number[] }[] = []
  const keySignatures: { key: string; scale: string; ticks: number }[] = []
  for (const track of p.tracks) {
    for (const ev of track) {
      if (ev.type === 'setTempo') {
        tempos.push({ bpm: 6e7 / (ev.data.microsecondsPerBeat as number), ticks: ev.tick })
      } else if (ev.type === 'timeSignature') {
        timeSignatures.push({
          ticks: ev.tick,
          timeSignature: [ev.data.numerator as number, ev.data.denominator as number],
        })
      } else if (ev.type === 'keySignature') {
        keySignatures.push({
          key: KEY_SIG_KEYS[(ev.data.key as number) + 7] ?? '',
          scale: ev.data.scale === 0 ? 'major' : 'minor',
          ticks: ev.tick,
        })
      }
    }
  }
  tempos.sort((a, b) => a.ticks - b.ticks)
  timeSignatures.sort((a, b) => a.ticks - b.ticks)

  // header.name = 轨 0 的最后一个 trackName（tonejs forEach 直接覆盖）
  const track0Names = p.tracks[0]?.filter(e => e.type === 'trackName') ?? []
  const header = {
    name: (track0Names[track0Names.length - 1]?.data.text as string) ?? '',
    ppq: p.ticksPerQuarter,
    tempos,
    timeSignatures,
    keySignatures,
  }

  // ---- 轨拆分（tonejs 语义：按 "当前program 通道" 分桶；无 channel 的事件归源轨首桶） ----
  // 注意：oracle 解析器的 channelPrefix 事件带顶层 channel，参与分桶
  const buckets: MidiEvent[][] = []
  for (const track of p.tracks) {
    const n = buckets.length
    const map = new Map<string, number>()
    const progs: number[] = new Array<number>(16).fill(0)
    for (const ev of track) {
      const effChannel = ev.channel ?? (ev.type === 'channelPrefix' ? (ev.data.channel as number) : undefined)
      let u = n
      if (effChannel !== undefined) {
        if (ev.type === 'programChange') {
          progs[effChannel] = ev.data.program as number
        }
        const key = `${progs[effChannel]} ${effChannel}`
        const found = map.get(key)
        if (found === undefined) {
          u = n + map.size
          map.set(key, u)
        } else {
          u = found
        }
      }
      ;(buckets[u] ??= []).push(ev)
    }
  }

  // ---- 每个 bucket → tone Track 视图 ----
  const tracks = buckets.map(track => {
    // 音符配对：按 tonejs 规则——noteOn 顺序 FIFO，找同 noteNumber 且时间 >= on 的第一个 noteOff（不看 channel）
    const ons = track.filter(e => e.type === 'noteOn')
    const offs = track.filter(e => e.type === 'noteOff').map(e => ({ e, used: false }))
    const notes: Record<string, unknown>[] = []
    let channel = 0
    for (const on of ons) {
      channel = on.channel ?? 0
      const idx = offs.findIndex(o => !o.used && o.e.data.key === on.data.key && o.e.tick >= on.tick)
      if (idx === -1) continue // 未配对的 noteOn 被 tonejs 丢弃
      const off = offs.splice(idx, 1)[0]!
      notes.push({
        ticks: on.tick,
        midi: on.data.key as number,
        velocity: (on.data.velocity as number) / 127,
        durationTicks: off.e.tick - on.tick,
      })
    }
    // tonejs addNote/addCC/addPitchBend 均按 ticks 插入排序（insert 为稳定上界插入）
    notes.sort((a, b) => (a.ticks as number) - (b.ticks as number))
    const controlChanges: Record<string, { number: number; ticks: number; value: number }[]> = {}
    for (const ev of track) {
      if (ev.type !== 'controller') continue
      const key = String(ev.data.controller)
      ;(controlChanges[key] ??= []).push({
        number: ev.data.controller as number,
        ticks: ev.tick,
        value: (ev.data.value as number) / 127,
      })
    }
    for (const arr of Object.values(controlChanges)) arr!.sort((a, b) => a.ticks - b.ticks)
    const pitchBends = track.filter(e => e.type === 'pitchBend').map(e => ({
      ticks: e.tick,
      value: (e.data.value as number) / 2 ** 13,
    }))
    pitchBends.sort((a, b) => a.ticks - b.ticks)
    const eot = track.find(e => e.type === 'endOfTrack')
    return {
      name: (track.find(e => e.type === 'trackName')?.data.text as string) ?? '',
      notes,
      channel,
      instrument: { number: (track.find(e => e.type === 'programChange')?.data.program as number) ?? 0 },
      controlChanges,
      pitchBends,
      ...(eot !== undefined ? { endOfTrackTicks: eot.tick } : {}),
    }
  })

  // tonejs 构造器规则：format 1 且首轨无音符（纯 meta 的 tempo-map 轨）→ 整轨丢弃
  if (p.format === 1 && tracks.length > 0 && (tracks[0]!.notes as unknown[]).length === 0) {
    tracks.shift()
  }

  return { header, tracks }
}

/** 找出两个结构化视图的第一个差异路径（调试用） */
export function firstDiffPath(a: unknown, b: unknown, path = '$'): string | null {
  const sa = JSON.stringify(a)
  const sb = JSON.stringify(b)
  if (sa === sb) return null
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) {
        const d = firstDiffPath(a[i], b[i], `${path}[${i}]`)
        if (d) return d
      }
      return `${path}: 数组长度 ${a.length} vs ${b.length}`
    }
    for (let i = 0; i < a.length; i++) {
      const d = firstDiffPath(a[i], b[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = a as Record<string, unknown>
    const kb = b as Record<string, unknown>
    for (const k of Object.keys(ka)) {
      if (!(k in kb)) return `${path}.${k}: 仅在 mine（${JSON.stringify(ka[k]).slice(0, 100)}）`
      const d = firstDiffPath(ka[k], kb[k], `${path}.${k}`)
      if (d) return d
    }
    for (const k of Object.keys(kb)) {
      if (!(k in ka)) return `${path}.${k}: 仅在 oracle（${JSON.stringify(kb[k]).slice(0, 100)}）`
    }
    return null
  }
  return `${path}: ${String(sa).slice(0, 100)} vs ${String(sb).slice(0, 100)}`
}

/** 规范化 tonejs toJSON 与我的视图到同一形状（剔除 name/family/measures/meta 等派生字段） */
export function normalizeToneJson(json: unknown): unknown {
  const j = json as {
    header?: { name?: string; ppq?: number; tempos?: { bpm: number; ticks: number }[];
      timeSignatures?: { ticks: number; timeSignature: number[] }[];
      keySignatures?: { key: string; scale: string; ticks: number }[] }
    tracks?: { name?: string; channel?: number; instrument?: { number?: number };
      notes?: { ticks: number; midi: number; velocity: number; durationTicks: number; noteOffVelocity: number }[];
      controlChanges?: Record<string, unknown[] | undefined>; pitchBends?: { ticks: number; value: number }[];
      endOfTrackTicks?: number }[]
  }
  const header = {
    name: j.header?.name ?? '',
    ppq: j.header?.ppq ?? 0,
    tempos: (j.header?.tempos ?? []).map(t => ({ bpm: t.bpm, ticks: t.ticks })),
    timeSignatures: (j.header?.timeSignatures ?? []).map(t => ({ ticks: t.ticks, timeSignature: t.timeSignature })),
    keySignatures: (j.header?.keySignatures ?? []).map(t => ({ key: t.key, scale: t.scale, ticks: t.ticks })),
  }
  const tracks = (j.tracks ?? []).map(tr => {
    const ccs: Record<string, unknown> = {}
    for (const [k, arr] of Object.entries(tr.controlChanges ?? {})) {
      ccs[k] = (arr as unknown as { number: number; ticks: number; value: number }[] ?? []).map(c => ({
        number: c.number, ticks: c.ticks, value: c.value,
      }))
    }
    return {
      name: tr.name ?? '',
      channel: tr.channel ?? 0,
      instrument: { number: tr.instrument?.number ?? 0 },
      notes: (tr.notes ?? []).map(n => ({
        ticks: n.ticks, midi: n.midi, velocity: n.velocity, durationTicks: n.durationTicks,
      })),
      controlChanges: ccs,
      pitchBends: (tr.pitchBends ?? []).map(pb => ({ ticks: pb.ticks, value: pb.value })),
      ...(tr.endOfTrackTicks !== undefined ? { endOfTrackTicks: tr.endOfTrackTicks } : {}),
    }
  })
  return { header, tracks }
}
