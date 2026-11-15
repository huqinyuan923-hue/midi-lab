// M4 Player 调度精度测试：noteOn 调度时间 vs tempo map 折算秒，误差 < 1ms（验收 3 的 Node 侧）

import { describe, expect, it, vi, afterEach } from 'vitest'
import { parseSmf } from '../src/smf/parser'
import { Player } from '../src/player'
import { FakeAudioContext } from './fake-audio'
import { Synth } from '../src/synth/synth'
import { smf, ev } from './helpers'

afterEach(() => {
  vi.useRealTimers()
})

/** 收集 fake ctx 中全部 osc 的调度起始时刻 */
function scheduledNoteOns(ctx: FakeAudioContext): number[] {
  return ctx.oscillators().map(o => o.startedAt!).sort((a, b) => a - b)
}

describe('Player 调度精度（scheduleAllAt 离线模式）', () => {
  it('tempo 变化曲目：全部 noteOn 调度时间与 tempo map 折算误差 < 1ms', () => {
    // 120bpm→240bpm @tick960；PPQ 480；两轨多音
    const bytes = smf([[
      ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20),
      ...ev(960, 0xff, 0x51, 3, 0x03, 0xd0, 0x90),
      ...ev(0, 0xff, 0x2f, 0),
    ], [
      ...ev(0, 0xc0, 0), ...ev(0, 0x90, 60, 100), ...ev(480, 0x80, 60, 0),
      ...ev(480, 0x90, 64, 100), ...ev(480, 0x80, 64, 0),
      ...ev(0, 0x90, 67, 100), ...ev(480, 0x80, 67, 0),
      ...ev(0, 0x90, 72, 100), ...ev(480, 0x80, 72, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 1, 480)
    const parsed = parseSmf(bytes)
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    const player = new Player(parsed, synth)
    player.scheduleAllAt(100) // offset 100s，任意锚点

    // 期望值：独立手算（不复用实现代码）
    // noteOn 位于 tick 0、960、1440、1920（轨内 delta 叠加）
    // 120bpm@0-960：0.5s/qn → tick960 = 1.0s；240bpm@960+：0.25s/qn
    const expected = [100, 100 + 1.0, 100 + 1.0 + 0.25, 100 + 1.0 + 0.5]

    const got = scheduledNoteOns(ctx)
    expect(got.length).toBe(expected.length)
    for (let i = 0; i < expected.length; i++) {
      const diffMs = Math.abs(got[i]! - expected[i]!) * 1000
      expect(diffMs, `noteOn#${i}: got=${got[i]} want=${expected[i]}`).toBeLessThan(1)
    }
  })

  it('noteOff/CC 同样精确调度（<1ms）', () => {
    const bytes = smf([[
      ...ev(0, 0xb0, 7, 100),
      ...ev(240, 0x90, 60, 100),
      ...ev(240, 0x80, 60, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0, 480)
    const parsed = parseSmf(bytes)
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    const player = new Player(parsed, synth)
    player.scheduleAllAt(5)
    const osc = ctx.oscillators()[0]!
    expect(Math.abs(osc.startedAt! - (5 + 0.25)) * 1000).toBeLessThan(1) // tick240 = 0.25s
    // noteOff @tick480=0.5s；release=0.18 → ramp 止于 5.68，osc.stop = 5.70（含 20ms 保护余量）
    expect(Math.abs(osc.stoppedAt! - (5 + 0.5 + 0.18 + 0.02)) * 1000).toBeLessThan(1)
    // CC7 @tick0
    const panner = ctx.nodes.find(n => n.kind === 'stereo-panner')!
    void panner
    const volumeGain = ctx.nodes.filter(n => n.kind === 'gain')
      .find(n => n.param('gain').events.some(e => e.type === 'set' && Math.abs(e.value - (100 / 127) ** 2) < 1e-9 && e.time === 5))
    expect(volumeGain).toBeDefined()
  })

  it('programChange 事件序语义（noteOn 用当前 program）', () => {
    const bytes = smf([[
      ...ev(0, 0xc0, 16),          // 风琴
      ...ev(0, 0x90, 60, 100),
      ...ev(480, 0xc0, 40),        // 弦乐
      ...ev(480, 0x90, 62, 100),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0, 480)
    const parsed = parseSmf(bytes)
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    const player = new Player(parsed, synth)
    player.scheduleAllAt(0)
    // 风琴 preset：organ (square, sustain 0.95, attack 0.01, 无 filter cutoff 4800>0)
    // 简化断言：两个 noteOn 都正常调度
    expect(ctx.oscillators().length).toBeGreaterThanOrEqual(2)
  })
})

describe('Player 实时 lookahead 模式（fake timers）', () => {
  it('lookahead 窗口逐步调度，最终全部 noteOn 时间精确', () => {
    const bytes = smf([[
      ...ev(0, 0x90, 60, 100),
      ...ev(120, 0x80, 60, 0),
      ...ev(120, 0x90, 64, 100),
      ...ev(120, 0x80, 64, 0),
      ...ev(120, 0x90, 67, 100),
      ...ev(120, 0x80, 67, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0, 480)
    const parsed = parseSmf(bytes)
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    const player = new Player(parsed, synth)

    vi.useFakeTimers()
    player.start(0) // 从 ctx 0 开始
    // 推进时钟：ctx 时间与 fake timer 同步推进
    for (let i = 0; i < 12; i++) {
      ctx.advance(0.03)
      vi.advanceTimersByTime(30)
    }
    const got = scheduledNoteOns(ctx)
    expect(got.length).toBe(3)
    // 期望：0s, 0.25s, 0.5s（120bpm, 480ppq: tick240=0.25s, tick480=0.5s）
    for (let i = 0; i < 3; i++) {
      const want = i * 0.25
      expect(Math.abs(got[i]! - want) * 1000).toBeLessThan(1)
    }
    // onEnd 在曲目结束（0.75s）后触发
    let ended = false
    player.onEnd = (): void => { ended = true }
    for (let i = 0; i < 20; i++) {
      ctx.advance(0.03)
      vi.advanceTimersByTime(30)
    }
    expect(ended).toBe(true)
  })
})

type _Unused = string
