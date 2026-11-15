// M2/M3 合成器装配测试（FakeAudioContext，Node 端）

import { describe, expect, it } from 'vitest'
import { Synth, envelopeValueAt } from '../src/synth/synth'
import { FakeAudioContext, FakeAudioNode, type FakeAudioParam } from './fake-audio'

/** 找到某个 osc 连向的 voice gain（通过连接图） */
function findOscGainPath(ctx: FakeAudioContext, osc: FakeAudioNode): FakeAudioNode[] {
  return osc.connections
}

describe('Synth 基础（FakeAudioContext）', () => {
  it('noteOn：创建 osc（自写 PeriodicWave）+ ADSR automation', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 69, 100, 0, 1.0)

    const oscs = ctx.oscillators()
    expect(oscs.length).toBe(1)
    const osc = oscs[0]!
    // 自写波形：imag[1] = 2/π（程序 0 = 钢琴 → sawtooth），Float32 精度
    expect(osc.periodicWave).not.toBeNull()
    expect(osc.periodicWave!.imag[1]).toBeCloseTo(2 / Math.PI, 7)
    // 频率 A4
    expect(osc.param('frequency').valueAt(1.0)).toBeCloseTo(440, 6)
    // ADSR：set 0 @1.0 → linear peak @1.003 → linear sustain @1.603
    const gainParam = osc.connections[0]!.connections[0]!.param('gain')
    // osc → [filter or gain] → gain(voice) → channelInput...：voice gain 是第一个 gain 连接目标中的"带 automation 0 起点"的那个
    // 简化：直接检查 ctx 中所有 gain 节点，找到 automation 起点为 0 且 ramp 到 100/127 的
    const voiceGain = ctx.nodes.filter(n => n.kind === 'gain').find(n => n.param('gain').events.some(e => e.type === 'set' && e.value === 0 && e.time === 1.0))
    expect(voiceGain).toBeDefined()
    const ev = voiceGain!.param('gain').events
    const peak = (100 / 127) * 0.13 // 含 VOICE_GAIN_SCALE
    expect(ev.some(e => e.type === 'linear' && Math.abs(e.value - peak) < 1e-9)).toBe(true)
    void gainParam
    void findOscGainPath
  })

  it('noteOff：release ramp 到 0 并调度 osc.stop', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 60, 127, 0, 0)
    synth.noteOff(0, 60, 1.0)
    const osc = ctx.oscillators()[0]!
    expect(osc.stoppedAt).toBeGreaterThan(1.0) // release 后 5ms 以上
    // gain 最终 ramp 到 0
    const voiceGain = ctx.nodes.filter(n => n.kind === 'gain').find(n => n.param('gain').events.some(e => e.type === 'set' && e.value === 0 && e.time === 0))
    expect(voiceGain).toBeDefined()
    const lastLinear = [...voiceGain!.param('gain').events].reverse().find(e => e.type === 'linear' && e.value === 0)
    expect(lastLinear).toBeDefined()
  })

  it('复音上限 32：第 33 个触发偷音（最旧）', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    for (let i = 0; i < 32; i++) synth.noteOn(0, 40 + i, 100, 0, i * 0.01)
    expect(ctx.oscillators().length).toBe(32)
    synth.noteOn(0, 90, 100, 0, 0.5)
    // 第 33 个 noteOn：偷最旧（第一个 osc 被调度 stop）
    expect(ctx.oscillators().length).toBe(33)
    const oldest = ctx.oscillators().find(o => o.startedAt === 0)!
    expect(oldest.stoppedAt).not.toBeNull()
  })

  it('同 key 重触发：旧语音淡出、新语音起音', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 60, 100, 0, 0)
    synth.noteOn(0, 60, 100, 0, 0.5)
    expect(ctx.oscillators().length).toBe(2)
    const first = ctx.oscillators()[0]!
    expect(first.stoppedAt).not.toBeNull() // 重触发时旧 osc 被调度停止
  })

  it('CC7 音量与 CC10 声像（通道 3）', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.setController(3, 7, 127, 0)
    synth.setController(3, 10, 127, 0)
    // 声道条按序创建：panner[3] 即通道 3
    const panners = ctx.nodes.filter(n => n.kind === 'stereo-panner')
    expect(panners.length).toBe(16)
    const panner = panners[3]!
    expect(panner.param('pan').valueAt(0)).toBeCloseTo(1, 12)
    const vol = panner.connections[0]!
    expect(vol.param('gain').valueAt(0)).toBeCloseTo(1, 12)
  })

  it('CC64 延音踏板：按下时 noteOff 保持、抬起统一释放', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.setController(0, 64, 127, 0) // 踏板按下
    synth.noteOn(0, 60, 100, 0, 0)
    synth.noteOff(0, 60, 0.5)
    const osc = ctx.oscillators()[0]!
    expect(osc.stoppedAt).toBeNull() // 踏板按下：不释放
    synth.setController(0, 64, 0, 1.0) // 踏板抬起
    expect(osc.stoppedAt).not.toBeNull() // 统一释放
  })

  it('打击乐通道 10：噪声路径（底鼓走正弦下滑）', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(9, 35, 100, 0, 0) // 底鼓
    const osc = ctx.oscillators()[0]!
    expect(osc).toBeDefined()
    expect(osc.periodicWave).not.toBeNull()
    expect(osc.param('frequency').valueAt(0)).toBeCloseTo(140, 9)
    synth.noteOn(9, 38, 100, 0, 0) // 军鼓 → buffer-source
    const noise = ctx.nodes.find(n => n.kind === 'buffer-source')
    expect(noise).toBeDefined()
  })

  it('noteOn velocity=0 → noteOff', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 60, 100, 0, 0)
    synth.noteOn(0, 60, 0, 0, 0.5) // vel 0 → noteOff
    expect(ctx.oscillators()[0]!.stoppedAt).not.toBeNull()
  })

  it('master/reverb 全局控制', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.setMasterVolume(0.5)
    synth.setReverbMix(0.3)
    // 不抛错即通过（Fake 记录 automation）
    expect(true).toBe(true)
  })

  it('allOff 释放全部未释放语音', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 60, 100, 0, 0)
    synth.noteOn(1, 62, 100, 0, 0)
    synth.allOff(0.1)
    for (const osc of ctx.oscillators()) {
      expect(osc.stoppedAt).not.toBeNull()
    }
  })
})

describe('envelopeValueAt 与 release 调度一致性（mid-attack 案例）', () => {
  it('mid-attack release 重插上升段无跳变', () => {
    const ctx = new FakeAudioContext()
    const synth = new Synth(ctx as unknown as BaseAudioContext)
    synth.noteOn(0, 60, 127, 40, 0) // strings: attack 0.09
    synth.noteOff(0, 60, 0.03)      // attack 中段释放
    // automation 事件时序单调且连续：0 @0 → value @0.03 → 0 @0.03+R
    const voiceGain = ctx.nodes.filter(n => n.kind === 'gain')
      .find(n => n.param('gain').events.some(e => e.type === 'set' && e.value === 0 && e.time === 0))
    expect(voiceGain).toBeDefined()
    const evs = voiceGain!.param('gain').events
      .filter(e => e.type !== 'cancel')
      .map(e => [e.time, e.value] as const)
    // 事件按时间排序
    const times = evs.map(e => e[0])
    expect([...times].sort((a, b) => a - b)).toEqual(times)
    // ramp 起点与 attack 解析值一致（连续性；含 VOICE_GAIN_SCALE=0.13）
    const expected = envelopeValueAt({ attack: 0.09, decay: 0.3, sustain: 0.85, release: 0.35 }, 0.13, 0, 0.03)
    const midRamp = evs.find(e => Math.abs(e[0] - 0.03) < 1e-9)
    expect(midRamp).toBeDefined()
    expect(midRamp![1]).toBeCloseTo(expected, 9)
  })
})

type _P = FakeAudioParam
