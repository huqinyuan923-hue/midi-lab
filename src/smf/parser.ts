// SMF (Standard MIDI File 1.0) 解析器
// 规格冻结于 1983 年的 MIDI 1.0 / SMF 1.0：头块 + 轨块 + delta time + running status。
// 对拍口径与 oracle（midi-file，@tonejs/midi 底层）一致：
//   - meta/sysex 不清除 running status（lastChannelStatus 仅被新的通道状态字节更新）
//   - noteOn velocity=0 归一化为 noteOff，并带 byte9 标记以便 round-trip 还原 0x90
//   - pitch bend 归一化为有符号值 -8192..8191
// 坏文件策略：截断 / 坏 chunk / running status 越轨 / meta 长度越界 → 一律抛错，绝不越界读。

import type { MidiEvent, ParsedSmf, SmpteDivision } from './types'
import { bytesToHex } from './types'

/** 带边界检查的字节读取器（越界即抛错，这是"坏文件必抛"的根基） */
class ByteReader {
  private readonly bytes: Uint8Array
  pos: number
  private readonly end: number // 本 chunk 的结束偏移（不含）

  constructor(bytes: Uint8Array, start: number, end: number) {
    this.bytes = bytes
    this.pos = start
    this.end = end
  }

  get remaining(): number {
    return this.end - this.pos
  }

  /** 读 1 字节；越过 chunk 边界即抛错 */
  u8(): number {
    if (this.pos >= this.end) {
      throw new Error(`SMF 解析错误：意外的数据截断（offset=${this.pos}，chunk 边界=${this.end}）`)
    }
    const b = this.bytes[this.pos]!
    this.pos++
    return b
  }

  /** 读无符号 16 位大端 */
  u16(): number {
    return (this.u8() << 8) | this.u8()
  }

  /** 读无符号 24 位大端 */
  u24(): number {
    return (this.u8() << 16) | (this.u8() << 8) | this.u8()
  }

  /** 读无符号 32 位大端 */
  u32(): number {
    return ((this.u8() << 24) | (this.u8() << 16) | (this.u8() << 8) | this.u8()) >>> 0
  }

  /** 读 n 字节（先验长度，超界抛错——meta 长度不符绝不越界） */
  readBytes(n: number): Uint8Array {
    if (n < 0 || this.remaining < n) {
      throw new Error(`SMF 解析错误：长度声明 ${n} 超出剩余 ${this.remaining} 字节（offset=${this.pos}）`)
    }
    const out = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  /** MIDI 变长数（varlen）：最高位为延续位；超过 4 字节视为坏文件 */
  varint(): number {
    let result = 0
    for (let i = 0; i < 4; i++) {
      const b = this.u8()
      if (b & 0x80) {
        result = (result << 7) | (b & 0x7f)
      } else {
        return (result << 7) | b
      }
    }
    throw new Error('SMF 解析错误：变长数超过 4 字节（坏文件）')
  }
}

/** 4 字节 ASCII chunk id（如 'MThd' / 'MTrk'） */
function readChunkId(r: ByteReader): string {
  const b = r.readBytes(4)
  return String.fromCharCode(b[0]!, b[1]!, b[2]!, b[3]!)
}

/** 解析单个 MTrk 轨块数据为绝对 tick 事件序列 */
function parseTrack(data: Uint8Array): MidiEvent[] {
  const r = new ByteReader(data, 0, data.length)
  const events: MidiEvent[] = []
  let tick = 0
  let lastChannelStatus: number | null = null // running status：仅通道事件更新，meta/sysex 不清除（与 oracle 一致）

  // 事件循环以 chunk 数据耗尽为准；EoT 之后若还有事件也照常解析（坏文件如实暴露）
  while (r.remaining > 0) {
    tick += r.varint()
    const status = r.u8()

    if (status < 0x80) {
      // running status：本字节实为 param1，复用上一个通道状态字节
      if (lastChannelStatus === null) {
        throw new Error(`SMF 解析错误：running status 出现在任何状态字节之前（tick=${tick}）`)
      }
      events.push(readChannelEvent(r, lastChannelStatus, status, tick))
      continue
    }

    if (status < 0xf0) {
      // 通道事件：0x80..0xEF
      lastChannelStatus = status
      events.push(readChannelEvent(r, status, r.u8(), tick))
      continue
    }

    if (status === 0xff) {
      // meta 事件：FF <type> <varlen> <data>
      const metatype = r.u8()
      const len = r.varint()
      events.push(readMetaEvent(r, metatype, len, tick))
      continue
    }

    if (status === 0xf0 || status === 0xf7) {
      // sysex：F0/F7 <varlen> <data>（F0 的 data 按 SMF 规范含结尾 F7；oracle 同口径原样保留）
      const len = r.varint()
      const bytes = r.readBytes(len)
      events.push({ tick, type: status === 0xf0 ? 'sysEx' : 'endSysEx', data: { bytes: bytesToHex(bytes) } })
      continue
    }

    // F1..F6、F8..FE 等系统消息不允许出现在 SMF 中
    throw new Error(`SMF 解析错误：非法状态字节 0x${status.toString(16)}（tick=${tick}）`)
  }

  return events
}

/** 读取通道事件；param1 为控制数据第一字节（running status 时由调用者传入） */
function readChannelEvent(r: ByteReader, status: number, param1: number, tick: number): MidiEvent {
  const channel = status & 0x0f
  switch (status >> 4) {
    case 0x8: {
      return { tick, type: 'noteOff', channel, data: { key: param1, velocity: r.u8() } }
    }
    case 0x9: {
      const velocity = r.u8()
      if (velocity === 0) {
        // noteOn velocity=0 → noteOff（byte9 标记原始形式，序列化时还原 0x90）
        return { tick, type: 'noteOff', channel, data: { key: param1, velocity: 0, byte9: 1 } }
      }
      return { tick, type: 'noteOn', channel, data: { key: param1, velocity } }
    }
    case 0xa: {
      return { tick, type: 'noteAftertouch', channel, data: { key: param1, amount: r.u8() } }
    }
    case 0xb: {
      return { tick, type: 'controller', channel, data: { controller: param1, value: r.u8() } }
    }
    case 0xc: {
      return { tick, type: 'programChange', channel, data: { program: param1 } }
    }
    case 0xd: {
      return { tick, type: 'channelAftertouch', channel, data: { amount: param1 } }
    }
    case 0xe: {
      // pitch bend：14 位值归一化为 -8192..8191（与 oracle 一致）
      const lsb = param1
      const msb = r.u8()
      return { tick, type: 'pitchBend', channel, data: { value: lsb + (msb << 7) - 0x2000 } }
    }
    default:
      // 不可达：status < 0xf0 已保证高半字节 8..E
      throw new Error(`SMF 解析错误：非法通道事件类型 0x${(status >> 4).toString(16)}`)
  }
}

/** 读取 meta 事件（长度不符即抛错，绝不越界） */
function readMetaEvent(r: ByteReader, metatype: number, len: number, tick: number): MidiEvent {
  switch (metatype) {
    case 0x00: {
      if (len !== 2) throw new Error(`SMF 解析错误：sequenceNumber 长度应为 2，实为 ${len}`)
      return { tick, type: 'sequenceNumber', data: { number: r.u16() } }
    }
    case 0x01: return { tick, type: 'text', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x02: return { tick, type: 'copyrightNotice', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x03: return { tick, type: 'trackName', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x04: return { tick, type: 'instrumentName', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x05: return { tick, type: 'lyrics', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x06: return { tick, type: 'marker', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x07: return { tick, type: 'cuePoint', data: { text: readLatin1(r.readBytes(len)) } }
    case 0x20: {
      if (len !== 1) throw new Error(`SMF 解析错误：channelPrefix 长度应为 1，实为 ${len}`)
      return { tick, type: 'channelPrefix', data: { channel: r.u8() } }
    }
    case 0x21: {
      if (len !== 1) throw new Error(`SMF 解析错误：portPrefix 长度应为 1，实为 ${len}`)
      return { tick, type: 'portPrefix', data: { port: r.u8() } }
    }
    case 0x2f: {
      if (len !== 0) throw new Error(`SMF 解析错误：endOfTrack 长度应为 0，实为 ${len}`)
      return { tick, type: 'endOfTrack', data: {} }
    }
    case 0x51: {
      if (len !== 3) throw new Error(`SMF 解析错误：setTempo 长度应为 3，实为 ${len}`)
      return { tick, type: 'setTempo', data: { microsecondsPerBeat: r.u24() } }
    }
    case 0x54: {
      if (len !== 5) throw new Error(`SMF 解析错误：smpteOffset 长度应为 5，实为 ${len}`)
      const hourByte = r.u8()
      const FRAME_RATES: Record<number, number> = { 0x00: 24, 0x20: 25, 0x40: 29, 0x60: 30 }
      const frameRate = FRAME_RATES[hourByte & 0x60]
      if (frameRate === undefined) throw new Error(`SMF 解析错误：smpteOffset 帧率位非法 0x${(hourByte & 0x60).toString(16)}`)
      return {
        tick, type: 'smpteOffset',
        data: { frameRate, hour: hourByte & 0x1f, min: r.u8(), sec: r.u8(), frame: r.u8(), subFrame: r.u8() },
      }
    }
    case 0x58: {
      if (len !== 2 && len !== 4) throw new Error(`SMF 解析错误：timeSignature 长度应为 2 或 4，实为 ${len}`)
      const numerator = r.u8()
      const denominator = 1 << r.u8()
      let metronome = 0x24
      let thirtyseconds = 0x08
      if (len === 4) { metronome = r.u8(); thirtyseconds = r.u8() }
      return { tick, type: 'timeSignature', data: { numerator, denominator, metronome, thirtyseconds } }
    }
    case 0x59: {
      if (len !== 2) throw new Error(`SMF 解析错误：keySignature 长度应为 2，实为 ${len}`)
      const keyByte = r.u8()
      const key = keyByte & 0x80 ? keyByte - 0x100 : keyByte // 有符号 -7..7
      const scale = r.u8()
      return { tick, type: 'keySignature', data: { key, scale } }
    }
    case 0x7f: {
      return { tick, type: 'sequencerSpecific', data: { bytes: bytesToHex(r.readBytes(len)) } }
    }
    default: {
      // 未知 meta：原始字节保留（差分按字节比对）
      return { tick, type: 'unknownMeta', data: { metatypeByte: metatype, bytes: bytesToHex(r.readBytes(len)) } }
    }
  }
}

/** meta 文本按 latin1 单字节映射（与 oracle 的 fromCharCode 一致，保证字节级往返） */
function readLatin1(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!)
  return s
}

/**
 * 解析 SMF 字节流。
 * 头块必须为 MThd；随后按头块声明的轨数读取 MTrk；轨道数之外的残余字节忽略（与 oracle 一致）。
 */
export function parseSmf(bytes: Uint8Array): ParsedSmf {
  if (bytes.length < 4) throw new Error('SMF 解析错误：文件过短（不足 4 字节）')
  const r = new ByteReader(bytes, 0, bytes.length)

  // ---- 头块 ----
  const headerId = readChunkId(r)
  if (headerId !== 'MThd') {
    throw new Error(`SMF 解析错误：期望 'MThd' 头块，实为 '${headerId}'`)
  }
  const headerLen = r.u32()
  if (headerLen < 6) throw new Error(`SMF 解析错误：MThd 长度 ${headerLen} < 6`)
  if (r.remaining < headerLen) throw new Error('SMF 解析错误：MThd 声明长度超出文件（截断）')
  const headerEnd = r.pos + headerLen

  const format = r.u16()
  if (format !== 0 && format !== 1 && format !== 2) {
    throw new Error(`SMF 解析错误：非法 format ${format}（仅支持 0/1/2）`)
  }
  const numTracks = r.u16()
  const division = r.u16()
  r.pos = headerEnd // 头块多余字节忽略（oracle 同口径）

  let ticksPerQuarter = 0
  let smpte: SmpteDivision | undefined
  if (division & 0x8000) {
    // SMPTE 时间格式：高位字节为负数帧率（0xE7=-25 → 25fps）
    smpte = { fps: 0x100 - (division >> 8), ticksPerFrame: division & 0xff }
    ticksPerQuarter = 0
  } else {
    ticksPerQuarter = division
    if (ticksPerQuarter === 0) throw new Error('SMF 解析错误：ticksPerQuarter 为 0（非法分割格式）')
  }

  // ---- 轨块 ----
  const tracks: MidiEvent[][] = []
  for (let i = 0; i < numTracks; i++) {
    if (r.remaining <= 0) {
      throw new Error(`SMF 解析错误：头块声明 ${numTracks} 轨，实际在第 ${i} 轨前数据耗尽（截断）`)
    }
    const chunkId = readChunkId(r)
    if (chunkId !== 'MTrk') {
      throw new Error(`SMF 解析错误：期望 'MTrk' 轨块，实为 '${chunkId}'`)
    }
    const chunkLen = r.u32()
    if (r.remaining < chunkLen) {
      throw new Error(`SMF 解析错误：MTrk 声明长度 ${chunkLen} 超出剩余 ${r.remaining} 字节（截断）`)
    }
    const trackData = bytes.subarray(r.pos, r.pos + chunkLen)
    r.pos += chunkLen
    tracks.push(parseTrack(trackData))
  }

  return { format, ticksPerQuarter, tracks, ...(smpte ? { smpte } : {}) }
}
