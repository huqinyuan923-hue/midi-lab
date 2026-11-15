// SMF 解析结果与事件的类型定义（任务书公开 API，签名固定）
// 事件词汇表与对拍 oracle（midi-file / @tonejs/midi 底层解析器）保持一致，
// 便于差分验收逐字段比对。

/** SMF 事件（绝对 tick；解析期已展开 running status） */
export interface MidiEvent {
  tick: number
  type: string
  channel?: number
  data: Record<string, number | string>
}

/** SMPTE 时间格式的补充信息（PPQ 曲目上不存在） */
export interface SmpteDivision {
  fps: number          // 每秒帧数（1..255，常见 24/25/29/30）
  ticksPerFrame: number // 每帧 tick 数
}

export interface ParsedSmf {
  format: 0 | 1 | 2
  ticksPerQuarter: number
  tracks: MidiEvent[][]
  /** SMPTE 分割格式时的原始参数；ticksPerQuarter 此时为 0（无节拍语义） */
  smpte?: SmpteDivision
}

/** 字节转十六进制串（sysex / unknownMeta 的原始字节比对用） */
export function bytesToHex(bytes: ArrayLike<number>): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i]! < 16 ? '0' : '') + bytes[i]!.toString(16)
  }
  return s
}

/** 十六进制串转字节数组（序列化用） */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}
