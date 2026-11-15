// Player：tempo map 折算 + lookahead 调度 + 全轨混音驱动。
// 实时模式：setTimeout 自调链（不使用 setInterval——抖动只影响"何时算"，不影响"何时响"，
// 音频事件全部以 AudioContext 精确时刻调度）。
// 离线模式：scheduleAllAt() 一次性把全部事件按精确时刻调度（OfflineAudioContext 验收用）。

import type { MidiEvent, ParsedSmf } from './smf/types'
import type { Synth } from './synth/synth'
import { secondsAtTick as tmSecondsAtTick, songDurationOf, tempoMapOf, type TempoSegment } from './player/tempo-map'

const LOOKAHEAD_S = 0.15   // 调度前瞻窗口（秒）
const LOOP_MS = 30         // 调度循环间隔（真实 setTimeout）

/** 调度时间线上的单个条目 */
interface TimelineEntry {
  seconds: number
  tick: number
  event: MidiEvent
}

export class Player {
  onEnd?: () => void

  private readonly parsed: ParsedSmf
  private readonly synth: Synth
  private readonly segments: TempoSegment[]
  private timeline: TimelineEntry[] = []
  private readonly durationS: number

  private playing = false
  private timer: ReturnType<typeof setTimeout> | null = null
  /** wall→ctx 映射锚点：事件 ctx 时间 = offset + seconds */
  private offset = 0
  private timelineIndex = 0
  private startedAtCtx = 0

  constructor(parsed: ParsedSmf, synth: Synth) {
    this.parsed = parsed
    this.synth = synth
    const map = tempoMapOf(parsed)
    this.segments = map.segments

    // 合并全部轨的通道事件（noteOn/noteOff/controller/programChange），按 tick 稳定排序
    const merged: TimelineEntry[] = []
    for (const track of parsed.tracks) {
      for (const ev of track) {
        if (ev.type === 'noteOn' || ev.type === 'noteOff' || ev.type === 'controller' || ev.type === 'programChange') {
          merged.push({ tick: ev.tick, seconds: 0, event: ev })
        }
      }
    }
    merged.sort((a, b) => a.tick - b.tick) // 稳定排序保持同 tick 顺序
    this.durationS = songDurationOf(parsed, map.segments)
    this.retime(merged)
    this.timeline = merged
  }

  /** 按 tempo map 折算全部条目的秒数（构造时一次；tempo map 静态） */
  private retime(entries: TimelineEntry[]): void {
    let seconds = 0
    let cursorTick = 0
    let usPerQuarter = 500000
    let i = 0
    // 与 tempoMapOf 相同的分段积分，但内联执行（timeline 已按 tick 排序）
    const tempos: { tick: number; us: number }[] = []
    for (const track of this.parsed.tracks) {
      for (const ev of track) {
        if (ev.type === 'setTempo') tempos.push({ tick: ev.tick, us: ev.data.microsecondsPerBeat as number })
      }
    }
    tempos.sort((a, b) => a.tick - b.tick)

    if (this.parsed.smpte) {
      const spT = 1 / (this.parsed.smpte.fps * this.parsed.smpte.ticksPerFrame)
      for (const e of entries) e.seconds = e.tick * spT
      return
    }

    const ppq = this.parsed.ticksPerQuarter
    for (const e of entries) {
      while (i < tempos.length && tempos[i]!.tick <= e.tick) {
        const t = tempos[i]!
        if (t.tick > cursorTick) {
          seconds += ((t.tick - cursorTick) / ppq) * (usPerQuarter / 1e6)
          cursorTick = t.tick
        }
        usPerQuarter = t.us
        i++
      }
      e.seconds = seconds + ((e.tick - cursorTick) / ppq) * (usPerQuarter / 1e6)
    }
  }

  /** 曲目总时长（秒） */
  get duration(): number {
    return this.durationS
  }

  /** tick → 秒（tempo map 折算，UI/可视化用） */
  secondsAtTick(tick: number): number {
    if (this.parsed.smpte) {
      return tick / (this.parsed.smpte.fps * this.parsed.smpte.ticksPerFrame)
    }
    return tmSecondsAtTick(tick, this.parsed.ticksPerQuarter, this.segments)
  }

  /** 当前播放头（秒，wall→ctx 映射） */
  get position(): number {
    if (!this.playing) return 0
    return Math.min(this.durationS, Math.max(0, this.ctxNow() - this.offset))
  }

  private ctxNow(): number {
    return this.synth.ctx.currentTime
  }

  /** 开始播放（when = AudioContext 起始时刻，默认立刻） */
  start(when?: number): void {
    if (this.playing) return
    this.playing = true
    this.startedAtCtx = Math.max(when ?? this.ctxNow() + 0.05, this.ctxNow())
    this.offset = this.startedAtCtx - this.ctxNow()
    this.timelineIndex = this.findStartIndex()
    this.scheduleDue()
    const tick = (): void => {
      if (!this.playing) return
      this.scheduleDue()
      if (this.position >= this.durationS) {
        this.playing = false
        this.synth.allOff(this.ctxNow())
        this.onEnd?.()
        return
      }
      this.timer = setTimeout(tick, LOOP_MS)
    }
    this.timer = setTimeout(tick, LOOP_MS)
  }

  /** 从头开始时跳过 tick 0 之前的事件（支持未来 seek 扩展） */
  private findStartIndex(): number {
    // 一期从 0 开始播放：全部条目有效
    return 0
  }

  /** 把 lookahead 窗口内的事件以精确 ctx 时刻调度 */
  private scheduleDue(): void {
    const horizon = this.ctxNow() + LOOKAHEAD_S
    while (this.timelineIndex < this.timeline.length) {
      const entry = this.timeline[this.timelineIndex]!
      const at = this.offset + entry.seconds
      if (at > horizon) break
      this.dispatch(entry, at)
      this.timelineIndex++
    }
  }

  /** 各通道当前 program（事件流顺序语义，dispatch 顺序即事件序） */
  private readonly currentPrograms = new Array<number>(16).fill(0)

  private dispatch(entry: TimelineEntry, at: number): void {
    const ev = entry.event
    switch (ev.type) {
      case 'noteOn':
        this.synth.noteOn(ev.channel!, ev.data.key as number, ev.data.velocity as number, this.currentPrograms[ev.channel!]!, at)
        break
      case 'noteOff':
        this.synth.noteOff(ev.channel!, ev.data.key as number, at)
        break
      case 'controller':
        this.synth.setController(ev.channel!, ev.data.controller as number, ev.data.value as number, at)
        break
      case 'programChange':
        this.currentPrograms[ev.channel!] = ev.data.program as number
        break
      default:
        break
    }
  }

  /** 停止播放并静音全部语音 */
  stop(): void {
    this.playing = false
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.synth.allOff(this.ctxNow())
  }

  /** 离线渲染模式：一次性调度全部事件（OfflineAudioContext 无实时时钟） */
  scheduleAllAt(offset: number): void {
    for (const entry of this.timeline) {
      this.dispatch(entry, offset + entry.seconds)
    }
    // 曲终释放全部（含未配对 noteOn / 踏板保持音）
    this.synth.allOff(offset + this.durationS)
  }
}
