// SMF 序列化器：ParsedSmf → 字节。
// 规范化选择（与 oracle 的 writer 一致，保证 parse→serialize→parse 事件级幂等）：
//   - running status 重新应用，但 meta/sysex 之后重置（宁可多写一个状态字节）
//   - timeSignature 固定写 4 字节（metronome/thirtyseconds）
//   - byte9=1 的 noteOff 还原为 0x90 + velocity=0
//   - meta 文本按 latin1 单字节往返
// 轨内事件按 tick 稳定排序后写 delta（同 tick 保持原顺序）。

import type { MidiEvent, ParsedSmf } from './types'
import { hexToBytes } from './types'

class ByteWriter {
  readonly out: number[] = []

  u8(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`SMF 序列化错误：字节值越界 ${v}`)
    this.out.push(v)
  }

  i8(v: number): void {
    if (!Number.isInteger(v) || v < -128 || v > 127) throw new Error(`SMF 序列化错误：有符号字节越界 ${v}`)
    this.out.push(v & 0xff)
  }

  u16(v: number): void {
    this.u8((v >> 8) & 0xff)
    this.u8(v & 0xff)
  }

  u24(v: number): void {
    this.u8((v >> 16) & 0xff)
    this.u8((v >> 8) & 0xff)
    this.u8(v & 0xff)
  }

  u32(v: number): void {
    this.u8((v >>> 24) & 0xff)
    this.u8((v >>> 16) & 0xff)
    this.u8((v >>> 8) & 0xff)
    this.u8(v & 0xff)
  }

  /** MIDI 变长数（最多 4 字节） */
  varint(v: number): void {
    if (!Number.isInteger(v) || v < 0 || v > 0x0fffffff) {
      throw new Error(`SMF 序列化错误：变长数越界 ${v}`)
    }
    if (v <= 0x7f) {
      this.out.push(v)
      return
    }
    const groups: number[] = []
    let rest = v
    while (rest > 0) {
      groups.push(rest & 0x7f)
      rest >>= 7
    }
    // 高位在前：延续字节带 0x80，最后（最低组）不带
    for (let i = groups.length - 1; i >= 0; i--) {
      this.out.push(i > 0 ? groups[i]! | 0x80 : groups[i]!)
    }
  }

  /** latin1 文本（每字符一字节，与解析口径互逆） */
  text(s: string): void {
    for (let i = 0; i < s.length; i++) {
      const code = s.codePointAt(i)!
      if (code > 0xff) throw new Error('SMF 序列化错误：meta 文本含非 latin1 字符')
      this.out.push(code)
    }
  }

  chunk(id: string, body: number[]): void {
    if (id.length !== 4) throw new Error('SMF 序列化错误：chunk id 必须为 4 字节')
    if (body.length > 0xffffffff) throw new Error('SMF 序列化错误：chunk 过长')
    for (let i = 0; i < 4; i++) this.u8(id.charCodeAt(i))
    this.u32(body.length)
    for (const b of body) this.out.push(b)
  }
}

const META_TEXT_TYPES: Record<string, number> = {
  text: 0x01, copyrightNotice: 0x02, trackName: 0x03, instrumentName: 0x04,
  lyrics: 0x05, marker: 0x06, cuePoint: 0x07,
}

/** 写单个事件（不含 delta）；返回新的 running status（meta/sysex 返回 null） */
function writeEvent(w: ByteWriter, ev: MidiEvent, lastStatus: number | null): number | null {
  const d = ev.data
  switch (ev.type) {
    // ---- meta 事件 ----
    case 'sequenceNumber':
      w.u8(0xff); w.u8(0x00); w.varint(2); w.u16(num(d, 'number'))
      return null
    case 'text': case 'copyrightNotice': case 'trackName': case 'instrumentName':
    case 'lyrics': case 'marker': case 'cuePoint': {
      const s = str(d, 'text')
      w.u8(0xff); w.u8(META_TEXT_TYPES[ev.type]!)
      w.varint(s.length); w.text(s)
      return null
    }
    case 'channelPrefix':
      w.u8(0xff); w.u8(0x20); w.varint(1); w.u8(num(d, 'channel'))
      return null
    case 'portPrefix':
      w.u8(0xff); w.u8(0x21); w.varint(1); w.u8(num(d, 'port'))
      return null
    case 'endOfTrack':
      w.u8(0xff); w.u8(0x2f); w.varint(0)
      return null
    case 'setTempo': {
      const us = num(d, 'microsecondsPerBeat')
      if (us <= 0 || us > 0xffffff) throw new Error(`SMF 序列化错误：tempo 越界 ${us}`)
      w.u8(0xff); w.u8(0x51); w.varint(3); w.u24(us)
      return null
    }
    case 'smpteOffset': {
      const FRAME_RATES: Record<number, number> = { 24: 0x00, 25: 0x20, 29: 0x40, 30: 0x60 }
      const rate = num(d, 'frameRate')
      const code = FRAME_RATES[rate]
      if (code === undefined) throw new Error(`SMF 序列化错误：非法帧率 ${rate}`)
      w.u8(0xff); w.u8(0x54); w.varint(5)
      w.u8((num(d, 'hour') & 0x1f) | code)
      w.u8(num(d, 'min')); w.u8(num(d, 'sec')); w.u8(num(d, 'frame')); w.u8(num(d, 'subFrame'))
      return null
    }
    case 'timeSignature': {
      const den = num(d, 'denominator')
      const exp = Math.round(Math.log2(den))
      if (den < 1 || !Number.isInteger(exp) || exp > 31 || 2 ** exp !== den) {
        throw new Error(`SMF 序列化错误：timeSignature 分母必须为 2 的幂 ${den}`)
      }
      w.u8(0xff); w.u8(0x58); w.varint(4)
      w.u8(num(d, 'numerator')); w.u8(exp); w.u8(num(d, 'metronome')); w.u8(num(d, 'thirtyseconds'))
      return null
    }
    case 'keySignature':
      w.u8(0xff); w.u8(0x59); w.varint(2); w.i8(num(d, 'key')); w.u8(num(d, 'scale'))
      return null
    case 'sequencerSpecific': {
      const bytes = hexToBytes(str(d, 'bytes'))
      w.u8(0xff); w.u8(0x7f); w.varint(bytes.length)
      for (const b of bytes) w.u8(b)
      return null
    }
    case 'unknownMeta': {
      const bytes = hexToBytes(str(d, 'bytes'))
      w.u8(0xff); w.u8(num(d, 'metatypeByte')); w.varint(bytes.length)
      for (const b of bytes) w.u8(b)
      return null
    }
    // ---- sysex ----
    case 'sysEx': case 'endSysEx': {
      const bytes = hexToBytes(str(d, 'bytes'))
      w.u8(ev.type === 'sysEx' ? 0xf0 : 0xf7)
      w.varint(bytes.length)
      for (const b of bytes) w.u8(b)
      return null
    }
    // ---- 通道事件 ----
    case 'noteOff': case 'noteOn': {
      // byte9=1 的 noteOff 还原为 0x90 + velocity=0（保留原始编码形式）
      const nibble = ev.type === 'noteOn' || num(d, 'byte9', 0) === 1 ? 0x9 : 0x8
      return finishChannel(w, nibble << 4 | requireChannel(ev.channel), lastStatus,
        [num(d, 'key'), num(d, 'velocity')])
    }
    case 'noteAftertouch':
      return finishChannel(w, 0xa0 | requireChannel(ev.channel), lastStatus,
        [num(d, 'key'), num(d, 'amount')])
    case 'controller': {
      const c = num(d, 'controller')
      if (c > 0x7f) throw new Error(`SMF 序列化错误：控制器号越界 ${c}`)
      return finishChannel(w, 0xb0 | requireChannel(ev.channel), lastStatus, [c, num(d, 'value')])
    }
    case 'programChange':
      return finishChannel(w, 0xc0 | requireChannel(ev.channel), lastStatus, [num(d, 'program')])
    case 'channelAftertouch':
      return finishChannel(w, 0xd0 | requireChannel(ev.channel), lastStatus, [num(d, 'amount')])
    case 'pitchBend': {
      const v = num(d, 'value')
      if (v < -0x2000 || v > 0x1fff) throw new Error(`SMF 序列化错误：pitch bend 越界 ${v}`)
      const value14 = 0x2000 + v
      return finishChannel(w, 0xe0 | requireChannel(ev.channel), lastStatus,
        [value14 & 0x7f, (value14 >> 7) & 0x7f])
    }
    default:
      throw new Error(`SMF 序列化错误：未知事件类型 '${ev.type}'`)
  }
}

/** 写状态字节（running status 可省略）与参数字节；返回本次状态字节供后续复用 */
function finishChannel(w: ByteWriter, status: number, lastStatus: number | null, params: number[]): number | null {
  if (status !== lastStatus) w.u8(status)
  for (const p of params) w.u8(p)
  return status
}

function requireChannel(ch: number | undefined): number {
  if (ch === undefined || !Number.isInteger(ch) || ch < 0 || ch > 15) {
    throw new Error(`SMF 序列化错误：通道事件缺少合法 channel（${ch}）`)
  }
  return ch
}

function num(d: Record<string, number | string>, key: string, fallback?: number): number {
  const v = d[key]
  if (v === undefined) {
    if (fallback !== undefined) return fallback
    throw new Error(`SMF 序列化错误：事件缺少字段 '${key}'`)
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`SMF 序列化错误：字段 '${key}' 不是数字`)
  return v
}

function str(d: Record<string, number | string>, key: string): string {
  const v = d[key]
  if (typeof v !== 'string') throw new Error(`SMF 序列化错误：字段 '${key}' 不是字符串`)
  return v
}

/** 单轨序列化：按 tick 稳定排序 → 计算 delta → 逐事件写入 */
function serializeTrack(events: MidiEvent[]): number[] {
  // 稳定排序保证同 tick 事件次序不变；解析结果本身有序，此步只兜底手造数据
  const sorted = events
    .map((ev, i) => ({ ev, i }))
    .sort((a, b) => a.ev.tick - b.ev.tick || a.i - b.i)
    .map(x => x.ev)

  const w = new ByteWriter()
  let lastStatus: number | null = null
  let lastTick = 0
  for (const ev of sorted) {
    const delta = ev.tick - lastTick
    if (delta < 0) throw new Error('SMF 序列化错误：事件 tick 倒退')
    lastTick = ev.tick
    w.varint(delta)
    lastStatus = writeEvent(w, ev, lastStatus)
  }
  return w.out
}

/**
 * 序列化整个 ParsedSmf。
 * 头块分割格式：有 smpte 时按 SMPTE 重建，否则写 ticksPerQuarter；轨数写实际轨数。
 */
export function serializeSmf(parsed: ParsedSmf): Uint8Array {
  const w = new ByteWriter()

  let division: number
  if (parsed.smpte) {
    division = ((0x100 - (parsed.smpte.fps & 0xff)) << 8) | (parsed.smpte.ticksPerFrame & 0xff)
  } else {
    if (parsed.ticksPerQuarter < 1 || parsed.ticksPerQuarter > 0x7fff) {
      throw new Error(`SMF 序列化错误：ticksPerQuarter 越界 ${parsed.ticksPerQuarter}`)
    }
    division = parsed.ticksPerQuarter
  }

  const hw = new ByteWriter()
  hw.u16(parsed.format)
  hw.u16(parsed.tracks.length)
  hw.u16(division)
  w.chunk('MThd', hw.out)

  for (const track of parsed.tracks) {
    w.chunk('MTrk', serializeTrack(track))
  }

  return new Uint8Array(w.out)
}
