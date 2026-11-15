// Tempo map：setTempo meta 事件的分段线性积分（tick → 秒），纯函数 Node 可测。
// SMPTE 时间格式不走 tempo map（规范如此），直接按帧率换算。

import type { MidiEvent, ParsedSmf } from '../smf/types'

export interface TempoSegment {
  /** tempo 生效的起始 tick（含） */
  tick: number
  /** 该段每 tick 的秒数 */
  secondsPerTick: number
}

export const DEFAULT_TEMPO_US = 500000 // 120 bpm

/** tick → 秒（PPQ 曲目） */
export function secondsAtTick(tick: number, ppq: number, segments: TempoSegment[]): number {
  let seconds = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!
    const next = segments[i + 1]
    const segEnd = next ? next.tick : Infinity
    if (tick <= seg.tick) break
    const spanTicks = Math.min(tick, segEnd) - seg.tick
    seconds += spanTicks * seg.secondsPerTick
  }
  return seconds
}

/** SMPTE 曲目：tick → 秒（与 tempo 无关） */
export function smpteSecondsAtTick(tick: number, smpte: { fps: number; ticksPerFrame: number }): number {
  return tick / (smpte.fps * smpte.ticksPerFrame)
}

/** 从解析结果构建 tempo map（收集所有轨的 setTempo） */
export function tempoMapOf(parsed: ParsedSmf): { ppq: number; segments: TempoSegment[] } {
  const tempoEvents: { tick: number; us: number }[] = []
  for (const track of parsed.tracks) {
    for (const ev of track) {
      if (ev.type === 'setTempo') {
        tempoEvents.push({ tick: ev.tick, us: ev.data.microsecondsPerBeat as number })
      }
    }
  }
  const sorted = [...tempoEvents].sort((a, b) => a.tick - b.tick)
  const segments: TempoSegment[] = []
  let cursor = 0
  let us = DEFAULT_TEMPO_US
  for (const ev of sorted) {
    if (ev.tick > cursor) {
      segments.push({ tick: cursor, secondsPerTick: us / 1e6 / parsed.ticksPerQuarter })
      cursor = ev.tick
    }
    us = ev.us
  }
  segments.push({ tick: cursor, secondsPerTick: us / 1e6 / parsed.ticksPerQuarter })
  return { ppq: parsed.ticksPerQuarter, segments }
}

/** 曲目总时长（秒）：最大 tick（含 endOfTrack）折算 */
export function songDurationOf(parsed: ParsedSmf, segments: TempoSegment[]): number {
  let maxTick = 0
  for (const track of parsed.tracks) {
    for (const ev of track) maxTick = Math.max(maxTick, ev.tick)
  }
  if (parsed.smpte) return smpteSecondsAtTick(maxTick, parsed.smpte)
  return secondsAtTick(maxTick, parsed.ticksPerQuarter, segments)
}
