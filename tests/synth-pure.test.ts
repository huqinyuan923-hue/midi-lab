// M2/M3 纯数学测试：波形系数 / ADSR 计划 / 复音池 / 自写 Biquad / tempo map

import { describe, expect, it } from 'vitest'
import { waveCoefficients, midiKeyToFreq, harmonicBudget, type WaveType } from '../src/synth/waves'
import { planAttack, planRelease, planStealFade } from '../src/synth/adsr'
import { VoicePool } from '../src/synth/voice-pool'
import { lowpassCoeffs, highpassCoeffs, biquadResponse, biquadProcessSample } from '../src/synth/biquad'
import { presetForProgram, presetKey } from '../src/synth/presets'
import { tempoMapOf, secondsAtTick, smpteSecondsAtTick, songDurationOf } from '../src/player/tempo-map'
import { envelopeValueAt } from '../src/synth/synth'
import { parseSmf } from '../src/smf/parser'
import { smf, ev } from './helpers'

describe('波形傅里叶系数', () => {
  it('正弦：仅基波 imag[1]=1', () => {
    const { real, imag } = waveCoefficients('sine', 16)
    expect(real[0]).toBe(0)
    expect(imag[1]).toBe(1)
    expect(imag[2]).toBe(0)
    expect(imag[3]).toBe(0)
  })

  it('方波：奇次谐波 4/(πn)，偶次为 0（Float32 精度 7 位）', () => {
    const { imag } = waveCoefficients('square', 8)
    expect(imag[1]).toBeCloseTo(4 / Math.PI, 6)
    expect(imag[2]).toBe(0)
    expect(imag[3]).toBeCloseTo(4 / (Math.PI * 3), 6)
    expect(imag[4]).toBe(0)
  })

  it('锯齿：全谐波 2/(πn) 交替符号', () => {
    const { imag } = waveCoefficients('sawtooth', 4)
    expect(imag[1]).toBeCloseTo(2 / Math.PI, 7)
    expect(imag[2]).toBeCloseTo(-2 / (Math.PI * 2), 7)
    expect(imag[3]).toBeCloseTo(2 / (Math.PI * 3), 7)
    expect(imag[4]).toBeCloseTo(-2 / (Math.PI * 4), 7)
  })

  it('三角波：奇次 8/(π²n²) 交替符号，快速衰减', () => {
    const { imag } = waveCoefficients('triangle', 5)
    expect(imag[1]).toBeCloseTo(8 / Math.PI ** 2, 7)
    expect(imag[3]).toBeCloseTo(-8 / (Math.PI ** 2 * 9), 7)
    expect(imag[5]).toBeCloseTo(8 / (Math.PI ** 2 * 25), 7)
    expect(imag[2]).toBe(0)
    expect(imag[4]).toBe(0)
  })

  it('四种波形合成信号峰值与均值检查（数值积分抽样）', () => {
    const N = 4096
    for (const type of ['sine', 'square', 'sawtooth', 'triangle'] as WaveType[]) {
      const { real, imag } = waveCoefficients(type, 64)
      let peak = 0
      let mean = 0
      for (let i = 0; i < N; i++) {
        const t = i / N
        let v = 0
        for (let n = 1; n <= 64; n++) {
          v += real[n]! * Math.cos(2 * Math.PI * n * t) + imag[n]! * Math.sin(2 * Math.PI * n * t)
        }
        peak = Math.max(peak, Math.abs(v))
        mean += v
      }
      mean /= N
      expect(mean, `${type} 直流分量`).toBeCloseTo(0, 6)
      expect(peak, `${type} 峰值`).toBeLessThan(1.6)
      expect(peak, `${type} 峰值下限`).toBeGreaterThan(0.5)
    }
  })

  it('midiKeyToFreq：A4=440、八度倍频', () => {
    expect(midiKeyToFreq(69)).toBeCloseTo(440, 9)
    expect(midiKeyToFreq(81)).toBeCloseTo(880, 9)
    expect(midiKeyToFreq(57)).toBeCloseTo(220, 9)
  })

  it('harmonicBudget：高频截断防混叠', () => {
    expect(harmonicBudget(48000, 100)).toBe(64)
    expect(harmonicBudget(48000, 800)).toBe(30)  // 24000/800=30，用满余量
    expect(harmonicBudget(48000, 5000)).toBe(8)  // 24000/5000=4 → clamp 到 8
    expect(harmonicBudget(48000, 2000)).toBe(12) // 24000/2000=12
  })
})

describe('ADSR 计划', () => {
  const params = { attack: 0.05, decay: 0.2, sustain: 0.6, release: 0.1 }
  it('起音段：0 → peak @A → peak*S @A+D', () => {
    const events = planAttack(params, 0.8, 10)
    expect(events.map(e => [e.time, e.value])).toEqual([
      [10, 0], [10.05, 0.8], [10.25, 0.48],
    ])
  })
  it('release：ramp 到 0', () => {
    const { events, endTime } = planRelease(params, 12)
    expect(events[0]).toEqual({ time: 12.1, value: 0, kind: 'linear-to' })
    expect(endTime).toBeCloseTo(12.1, 12)
  })
  it('steal fade 默认 15ms', () => {
    const { endTime } = planStealFade(5)
    expect(endTime).toBeCloseTo(5.015, 12)
  })
  it('envelopeValueAt 分段解析值', () => {
    const t0 = 3
    expect(envelopeValueAt(params, 1, t0, t0 - 1)).toBe(0)
    expect(envelopeValueAt(params, 1, t0, t0 + 0.025)).toBeCloseTo(0.5, 12)
    expect(envelopeValueAt(params, 1, t0, t0 + 0.05)).toBeCloseTo(1, 12)
    expect(envelopeValueAt(params, 1, t0, t0 + 0.15)).toBeCloseTo(0.8, 12)
    expect(envelopeValueAt(params, 1, t0, t0 + 0.3)).toBeCloseTo(0.6, 12)
    expect(envelopeValueAt(params, 1, t0, t0 + 1)).toBeCloseTo(0.6, 12)
  })
})

describe('复音池', () => {
  it('上限 32，超限偷最旧', () => {
    const pool = new VoicePool()
    const first = pool.allocate(0, 60, 0, Infinity).voice
    for (let i = 1; i < 32; i++) pool.allocate(0, 60 + i, i * 0.01, Infinity)
    expect(pool.size).toBe(32)
    const res = pool.allocate(5, 100, 10, Infinity)
    expect(res.stolen).toBeDefined()
    expect(res.stolen!.id).toBe(first.id)
    expect(pool.size).toBe(32)
  })

  it('同 key 重触发返回旧语音', () => {
    const pool = new VoicePool()
    const v1 = pool.allocate(0, 60, 0, Infinity).voice
    const res = pool.allocate(0, 60, 1, Infinity)
    expect(res.stolen).toBeDefined()
    expect(res.stolen!.id).toBe(v1.id)
  })

  it('release + sweep 回收到期语音', () => {
    const pool = new VoicePool()
    const v = pool.allocate(0, 60, 0, 10).voice // endsAt=10
    pool.release(v.id)
    expect(pool.size).toBe(1) // released 但未到期仍在
    const dead = pool.sweep(10)
    expect(dead.map(d => d.id)).toEqual([v.id])
    expect(pool.size).toBe(0)
  })
})

describe('自写 Biquad（RBJ 系数）', () => {
  const sr = 48000
  it('低通：低频增益≈1、高频强衰减、截止点≈-3dB', () => {
    const c = lowpassCoeffs(sr, 1000, 0.707)
    expect(biquadResponse(c, 50, sr).magnitude).toBeGreaterThan(0.99)
    expect(biquadResponse(c, 20000, sr).magnitude).toBeLessThan(0.02)
    // 截止频率处 ~ -3dB（0.707）
    const atF0 = biquadResponse(c, 1000, sr).magnitude
    expect(atF0).toBeGreaterThan(0.6)
    expect(atF0).toBeLessThan(0.8)
  })

  it('高通：与低通镜像', () => {
    const c = highpassCoeffs(sr, 1000, 0.707)
    expect(biquadResponse(c, 50, sr).magnitude).toBeLessThan(0.02)
    expect(biquadResponse(c, 20000, sr).magnitude).toBeGreaterThan(0.99)
  })

  it('系数归一化稳定（a0 归一后 |a1|<2、|a2|<1）', () => {
    for (const f of [20, 440, 1000, 8000, 20000]) {
      const c = lowpassCoeffs(sr, f, 1.2)
      expect(Math.abs(c.a1)).toBeLessThan(2)
      expect(Math.abs(c.a2)).toBeLessThan(1)
    }
  })

  it('DF1 差分方程与频率响应一致（单音注入能量谱估计）', () => {
    const c = lowpassCoeffs(sr, 2000, 0.707)
    // 生成 200Hz 正弦（远低于截止）应近似无衰减
    const state = { x1: 0, x2: 0, y1: 0, y2: 0 }
    const freq = 200
    const n = 2048
    let cosSum = 0
    let sinSum = 0
    for (let i = 0; i < n; i++) {
      const t = i / sr
      const x = Math.sin(2 * Math.PI * freq * t)
      const y = biquadProcessSample(c, state, x)
      if (i >= n / 2) { // 跳过暂态
        cosSum += y * Math.cos(2 * Math.PI * freq * t)
        sinSum += y * Math.sin(2 * Math.PI * freq * t)
      }
    }
    const gain = Math.hypot(cosSum, sinSum) / (n / 4)
    expect(gain).toBeGreaterThan(0.9)
    expect(gain).toBeLessThan(1.01)
  })
})

describe('GM 预设映射', () => {
  it('家族分桶合理性抽查', () => {
    expect(presetForProgram(0).name).toBe('钢琴')
    expect(presetForProgram(19).name).toBe('风琴')   // 教堂风琴
    expect(presetForProgram(40).name).toBe('弦乐')   // 小提琴
    expect(presetForProgram(33).name).toBe('贝斯')   // 指弹贝斯
    expect(presetForProgram(56).name).toBe('铜管')   // 小号
    expect(presetForProgram(126).name).toBe('音效/打击') // 越界 program 环回
  })
  it('presetKey 稳定（节点池键）', () => {
    expect(presetKey(0)).toBe(presetKey(1))   // 同为钢琴桶
    expect(presetKey(0)).not.toBe(presetKey(16)) // 风琴桶不同
  })
})

describe('软限幅曲线', () => {
  it('线性区直通、压缩段连续、端点 < 1', async () => {
    const { softClipCurve, softClipEndpoint, SOFT_CLIP_THRESHOLD } = await import('../src/synth/soft-clip')
    const curve = softClipCurve(2049)
    expect(curve.length).toBe(2049)
    // 中点 = 0
    expect(curve[1024]).toBe(0)
    // 线性区：|x| ≤ 0.85 直通
    const linIdx = Math.round(0.5 * 1024 + 1024)
    expect(curve[linIdx]).toBeCloseTo(0.5, 9)
    // 端点（超界钳位结果）严格 < 1
    const ep = softClipEndpoint()
    expect(ep).toBeLessThan(1)
    expect(curve[2048]).toBeCloseTo(ep, 6)
    // 单调性
    for (let i = 1; i < curve.length; i++) {
      expect(curve[i]!).toBeGreaterThanOrEqual(curve[i - 1]!)
    }
    // 斜率连续：阈值处左右导数一致（数值抽查）
    const dt = 2 / 2048
    const t = SOFT_CLIP_THRESHOLD
    const idx = Math.round((t + 1) / 2 * 2048)
    const before = (curve[idx]! - curve[idx - 1]!) / dt
    const after = (curve[idx + 1]! - curve[idx]!) / dt
    expect(Math.abs(before - after)).toBeLessThan(0.05)
  })
})

describe('tempo map', () => {
  it('默认 120bpm：tick→秒 线性', () => {
    const bytes = smf([[...ev(0, 0x90, 60, 90), ...ev(0, 0xff, 0x2f, 0)]], 0, 480)
    const p = parseSmf(bytes)
    const map = tempoMapOf(p)
    expect(secondsAtTick(480, 480, map.segments)).toBeCloseTo(0.5, 12)
    expect(secondsAtTick(960, 480, map.segments)).toBeCloseTo(1.0, 12)
  })

  it('tempo 变化插值（120→240bpm @tick960）', () => {
    const bytes = smf([[
      ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20),
      ...ev(960, 0xff, 0x51, 3, 0x03, 0xd0, 0x90),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0, 480)
    const p = parseSmf(bytes)
    const map = tempoMapOf(p)
    expect(secondsAtTick(480, 480, map.segments)).toBeCloseTo(0.5, 12)
    expect(secondsAtTick(960, 480, map.segments)).toBeCloseTo(1.0, 12)
    // 变速后每 tick 0.25ms（250000us/qn → 0.5s/qn）
    expect(secondsAtTick(1920, 480, map.segments)).toBeCloseTo(1.5, 12)
  })

  it('SMPTE 直接换算', () => {
    expect(smpteSecondsAtTick(1000, { fps: 25, ticksPerFrame: 40 })).toBeCloseTo(1.0, 12)
  })

  it('曲目总时长', () => {
    const bytes = smf([[
      ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20),
      ...ev(960, 0x90, 60, 90),
      ...ev(960, 0x80, 60, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0, 480)
    const p = parseSmf(bytes)
    const map = tempoMapOf(p)
    // maxTick=1920 → 1920/480 qn × 0.5s = 2.0s
    expect(songDurationOf(p, map.segments)).toBeCloseTo(2.0, 12)
  })
})
