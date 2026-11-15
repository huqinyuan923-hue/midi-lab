// 软件合成器：Web Audio 装配层。
// 架构：osc(自写 PeriodicWave 系数) → [自写 Biquad AudioWorklet] → voiceGain(ADSR automation)
//       → 声道条(Gain/StereoPanner) → 主混音 → masterGain → destination → 混响发送（M5 接入）。
// 打击乐通道 10：白噪声 + 音高映射三件套。
// 约定：when 为可选参数——任务书签名固定，附加可选参数供 Player 精确调度（实现决策）。

import { planAttack, type AdsrParams, type AutomationEvent } from './adsr'
import { highpassCoeffs, lowpassCoeffs, type BiquadCoeffs } from './biquad'
import { presetForProgram, presetKey } from './presets'
import { createBiquadWorkletUrl } from './worklet-source'
import { VoicePool, type VoiceRecord } from './voice-pool'
import { harmonicBudget, midiKeyToFreq, waveCoefficients, type WaveType } from './waves'

const PERC_CHANNEL = 9 // 通道 10（0 起）
const MASTER_DEFAULT = 0.9
const REVERB_SEND_DEFAULT = 0.22
const REVERB_WET_GAIN = 0.9
/**
 * 每 voice 幅度定标：配合总线软限幅（soft-clip.ts）控制最坏 32 复音叠加的削波频率。
 * 单音听感偏轻——正确性优先，用户可调主音量补偿（REPORT 已知限制记录）。
 */
const VOICE_GAIN_SCALE = 0.13

interface VoiceNodes {
  oscs: OscillatorNode[]
  gain: GainNode
  filter: AudioWorkletNode | null
  filterPkey: string | null
  preset: PresetLike
  peak: number
  t0: number
  endTime: number
}

type PresetLike = { name: string; wave: WaveType; adsr: AdsrParams; detune: number; cutoff: number; q: number }

/** 包络计划在任意时刻 t 的解析值（release/steal 无 cancelAndHold 依赖的关键） */
export function envelopeValueAt(params: AdsrParams, peak: number, t0: number, t: number): number {
  const a = Math.max(params.attack, 0.001)
  const d = Math.max(params.decay, 0)
  if (t <= t0) return 0
  if (t < t0 + a) return peak * (t - t0) / a
  if (d > 0 && params.sustain < 1) {
    if (t < t0 + a + d) return peak * (1 - (1 - params.sustain) * (t - t0 - a) / d)
  }
  return peak * params.sustain
}

/** 把 automation 计划应用到 AudioParam */
function applyAutomation(param: AudioParam, events: AutomationEvent[]): void {
  for (const ev of events) {
    if (ev.kind === 'set') param.setValueAtTime(ev.value, ev.time)
    else param.linearRampToValueAtTime(ev.value, ev.time)
  }
}

export class Synth {
  readonly ctx: BaseAudioContext
  /** worklet 模块加载完成（浏览器端必须 await；FakeAudioContext 立即 resolve） */
  readonly ready: Promise<void>

  private readonly mix: GainNode
  private readonly master: GainNode
  /** 主总线软限幅节点（worklet 就绪后插入） */
  private masterClip: AudioWorkletNode | null = null
  private readonly reverbSend: GainNode
  /** 混响发送总线（并行于干声；避免湿声回 mix 后被再次发送形成再生环） */
  private readonly sendBus: GainNode
  private readonly channelInputs: GainNode[] = []
  private readonly channelPans: StereoPannerNode[] = []
  private readonly channelVolumes: GainNode[] = []

  private readonly pool = new VoicePool()
  private readonly voiceNodes = new Map<number, VoiceNodes>()
  /** AudioWorklet 节点池：按 presetKey 分池（系数经 processorOptions 同步注入） */
  private readonly filterPool = new Map<string, AudioWorkletNode[]>()
  private readonly waveCache = new Map<string, PeriodicWave>()
  private noiseBuffer: AudioBuffer | null = null
  private nextNoiseOffset = 0

  private readonly pedalDown: boolean[] = new Array<boolean>(16).fill(false)
  private readonly sustained: Set<number>[] = Array.from({ length: 16 }, () => new Set<number>())

  constructor(ctx: BaseAudioContext) {
    this.ctx = ctx

    this.mix = ctx.createGain()
    this.master = ctx.createGain()
    this.master.gain.value = MASTER_DEFAULT
    this.mix.connect(this.master)
    // 主总线先直通 destination；worklet 就绪后插入软限幅节点（见 setupWorklet）。
    // 未就绪的启动瞬间无限幅（无音符，无影响）。
    this.master.connect(ctx.destination)

    this.reverbSend = ctx.createGain()
    this.reverbSend.gain.value = REVERB_SEND_DEFAULT
    // 干声总线与发送总线分离：湿声由 attachReverb() 接回 mix，但发送源头是 sendBus（无环路）
    this.sendBus = ctx.createGain()
    this.sendBus.connect(this.reverbSend)
    // 混响网络由 M5 attachReverb() 接回 mix

    for (let ch = 0; ch < 16; ch++) {
      const input = ctx.createGain()
      const pan = ctx.createStereoPanner()
      const vol = ctx.createGain()
      input.connect(pan)
      pan.connect(vol)
      vol.connect(this.mix)
      vol.connect(this.sendBus)
      vol.gain.value = (100 / 127) ** 2 // GM 默认 CC7 = 100
      this.channelInputs.push(input)
      this.channelPans.push(pan)
      this.channelVolumes.push(vol)
    }

    this.ready = this.setupWorklet()
  }

  private async setupWorklet(): Promise<void> {
    const aw = this.ctx.audioWorklet
    if (!aw) return // Fake 环境（测试）降级：无滤波/无限幅
    await aw.addModule(createBiquadWorkletUrl())
    // 插入主总线软限幅（保证 <0dBFS，验收 4）
    try {
      const clip = new AudioWorkletNode(this.ctx as AudioContext, 'midi-lab-master', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      })
      this.master.disconnect(this.ctx.destination)
      this.master.connect(clip)
      clip.connect(this.ctx.destination)
      this.masterClip = clip
    } catch {
      // worklet 节点创建失败：保持直通（REPORT 已知限制）
    }
  }

  /** PeriodicWave 缓存（按类型+谐波数） */
  private wave(type: WaveType, harmonics: number): PeriodicWave {
    const key = `${type}#${harmonics}`
    let w = this.waveCache.get(key)
    if (!w) {
      const { real, imag } = waveCoefficients(type, harmonics)
      w = this.ctx.createPeriodicWave(real, imag, { disableNormalization: false })
      this.waveCache.set(key, w)
    }
    return w
  }

  /** 白噪声缓冲（1 秒，DSP 用途的 Math.random 足够） */
  private noise(): AudioBuffer {
    if (!this.noiseBuffer) {
      const len = Math.floor(this.ctx.sampleRate)
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
      const data = buf.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
      this.noiseBuffer = buf
    }
    return this.noiseBuffer
  }

  /** 滤波节点池：空闲则复用（发 reset 消息清状态），否则新建 */
  private acquireFilter(pkey: string, coeffs: BiquadCoeffs): AudioWorkletNode | null {
    const idle = this.filterPool.get(pkey)
    if (idle && idle.length > 0) {
      const node = idle.pop()!
      node.port.postMessage({ reset: true })
      this.filterReuseCount++
      return node
    }
    try {
      const node = new AudioWorkletNode(this.ctx as AudioContext, 'midi-lab-biquad', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { ...coeffs },
      })
      this.filterCreateCount++
      return node
    } catch {
      return null // worklet 未就绪 → 直通（启动瞬间，听感可忽略）
    }
  }

  /** 节点池诊断计数（性能分析用） */
  filterCreateCount = 0
  filterReuseCount = 0

  private releaseFilter(pkey: string, node: AudioWorkletNode): void {
    node.disconnect()
    const idle = this.filterPool.get(pkey) || []
    if (idle.length < 32) {
      idle.push(node)
      this.filterPool.set(pkey, idle)
    }
  }

  // ---------- 复音 ----------

  noteOn(channel: number, key: number, velocity: number, program: number, when?: number): void {
    if (velocity <= 0) return this.noteOff(channel, key, when)
    const ch = ((Math.floor(channel) % 16) + 16) % 16
    const k = Math.max(0, Math.min(127, Math.floor(key)))
    const vel = Math.max(1, Math.min(127, Math.floor(velocity)))
    const t0 = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime)
    this.sweep(t0)

    if (ch === PERC_CHANNEL) return this.percNoteOn(k, vel, t0)
    const preset = presetForProgram(program)
    const peak = (vel / 127) * VOICE_GAIN_SCALE
    const freq = midiKeyToFreq(k)
    const harmonics = harmonicBudget(this.ctx.sampleRate, freq)

    const result = this.pool.allocate(ch, k, t0, Infinity)
    // 同 key 重触发 / 上限偷音：快速淡出旧语音
    if (result.stolen) this.killVoice(result.stolen, t0, 0.015)

    const gain = this.ctx.createGain()
    applyAutomation(gain.gain, planAttack(preset.adsr, peak, t0))

    const oscs: OscillatorNode[] = []
    for (let i = 0; i < (preset.detune > 0 ? 2 : 1); i++) {
      const osc = this.ctx.createOscillator()
      osc.setPeriodicWave(this.wave(preset.wave, harmonics))
      osc.frequency.setValueAtTime(freq, t0)
      if (i === 1) osc.detune.setValueAtTime(preset.detune, t0)
      oscs.push(osc)
    }

    let filter: AudioWorkletNode | null = null
    if (preset.cutoff > 0) {
      const coeffs = lowpassCoeffs(this.ctx.sampleRate, preset.cutoff, preset.q)
      filter = this.acquireFilter(presetKey(program), coeffs)
    }
    for (const osc of oscs) {
      osc.connect(filter || gain)
    }
    if (filter) filter.connect(gain)
    gain.connect(this.channelInputs[ch]!)
    for (const osc of oscs) osc.start(t0)

    this.voiceNodes.set(result.voice.id, { oscs, gain, filter, filterPkey: preset.cutoff > 0 ? presetKey(program) : null, preset, peak, t0, endTime: Infinity })
  }

  noteOff(channel: number, key: number, when?: number): void {
    const ch = ((Math.floor(channel) % 16) + 16) % 16
    const k = Math.max(0, Math.min(127, Math.floor(key)))
    const tOff = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime)

    const targets: VoiceRecord[] = (this.pool.list() as VoiceRecord[]).filter(
      v => v.channel === ch && v.key === k && !v.released && this.voiceNodes.has(v.id),
    )
    if (targets.length === 0) return

    if (this.pedalDown[ch]) {
      for (const v of targets) this.sustained[ch]!.add(v.id)
      return
    }
    for (const v of targets) this.releaseVoice(v, tOff)
  }

  setController(channel: number, controller: number, value: number, when?: number): void {
    const ch = ((Math.floor(channel) % 16) + 16) % 16
    const v = Math.max(0, Math.min(127, Math.floor(value)))
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime)

    switch (controller) {
      case 7:
        // 音量：感知平方律
        this.channelVolumes[ch]!.gain.setValueAtTime((v / 127) ** 2, t)
        break
      case 10:
        // 声像：0..127 → -1..1
        this.channelPans[ch]!.pan.setValueAtTime((v - 64) / 63, t)
        break
      case 64: {
        // 延音踏板（采样保持语义）
        const down = v >= 64
        if (down && !this.pedalDown[ch]) {
          this.pedalDown[ch] = true
        } else if (!down && this.pedalDown[ch]) {
          this.pedalDown[ch] = false
          const ids = [...this.sustained[ch]!]
          this.sustained[ch]!.clear()
          for (const id of ids) {
            const rec = (this.pool.list() as VoiceRecord[]).find(x => x.id === id)
            if (rec && !rec.released) this.releaseVoice(rec, t)
          }
        }
        break
      }
      default:
        break // 一期只实现 CC7/CC10/CC64
    }
  }

  // ---------- 语音生命周期 ----------

  /** 调度 release：包络解析值 + cancel + mid-attack 重插值（避免 cancelAndHold 兼容性） */
  private releaseVoice(rec: VoiceRecord, tOff: number): void {
    const nodes = this.voiceNodes.get(rec.id)
    if (!nodes) return
    const params = nodes.preset.adsr
    const r = Math.max(params.release, 0.005)
    const endTime = tOff + r
    this.applyReleaseEnvelope(nodes, tOff, r)
    nodes.endTime = endTime
    rec.released = true
    rec.endsAt = endTime
    this.pool.release(rec.id)
  }

  /** 偷音/重触发快速淡出 */
  private killVoice(rec: VoiceRecord, tNow: number, fade: number): void {
    const nodes = this.voiceNodes.get(rec.id)
    if (!nodes) return
    const endTime = tNow + fade
    this.applyReleaseEnvelope(nodes, tNow, fade)
    nodes.endTime = endTime
    rec.released = true
    rec.endsAt = endTime
    this.pool.release(rec.id)
  }

  /**
   * release/steal 的包络调度（无 cancelAndHold 依赖）：
   * cancel(tNow) → 补回 mid-attack 上升段（解析值）→ setValue(valueAt) → ramp 到 0。
   */
  private applyReleaseEnvelope(nodes: VoiceNodes, tNow: number, fade: number): void {
    const gain = nodes.gain.gain
    const end = tNow + fade
    if (tNow <= nodes.t0) {
      // 未起音即释放：静音取消
      gain.cancelScheduledValues(nodes.t0)
      gain.setValueAtTime(0, nodes.t0)
    } else {
      const valueAt = envelopeValueAt(nodes.preset.adsr, nodes.peak, nodes.t0, tNow)
      gain.cancelScheduledValues(tNow)
      const a = Math.max(nodes.preset.adsr.attack, 0.001)
      if (tNow < nodes.t0 + a) {
        // mid-attack：重插上升段保证连续
        gain.setValueAtTime(0, nodes.t0)
        gain.linearRampToValueAtTime(valueAt, tNow)
        gain.linearRampToValueAtTime(0, end)
      } else {
        gain.setValueAtTime(valueAt, tNow)
        gain.linearRampToValueAtTime(0, end)
      }
    }
    for (const osc of nodes.oscs) {
      try { osc.stop(end + 0.02) } catch { /* 已 stop（double-stop 保护） */ }
    }
  }

  /** 回收到期语音：断开节点、归还滤波节点 */
  private sweep(now: number): void {
    for (const rec of this.pool.sweep(now)) {
      const nodes = this.voiceNodes.get(rec.id)
      if (nodes) {
        for (const osc of nodes.oscs) {
          try { osc.stop(now) } catch { /* 已 stop */ }
        }
        nodes.gain.disconnect()
        if (noiseFilterCleanup(nodes)) {
          this.releaseFilter(nodes.filterPkey!, nodes.filter!)
        }
        this.voiceNodes.delete(rec.id)
      }
    }
  }

  // ---------- 打击乐（通道 10） ----------

  private percNoteOn(key: number, vel: number, t0: number): void {
    const result = this.pool.allocate(PERC_CHANNEL, key, t0, Infinity)
    if (noteSteal(result.stolen)) {
      this.killVoice(result.stolen!, t0, 0.01)
    }

    const peak = (vel / 127) * VOICE_GAIN_SCALE
    let endTime = t0 + 0.3

    if (key === 35 || key === 36) {
      // 底鼓：正弦下滑
      const gain = this.ctx.createGain()
      const osc = this.ctx.createOscillator()
      osc.setPeriodicWave(this.wave('sine', 8))
      osc.frequency.setValueAtTime(140, t0)
      osc.frequency.exponentialRampToValueAtTime(45, t0 + 0.1)
      applyAutomation(gain.gain, [
        { time: t0, value: 0, kind: 'set' },
        { time: t0 + 0.004, value: peak * 0.95, kind: 'linear-to' },
        { time: t0 + 0.35, value: 0, kind: 'linear-to' },
      ])
      osc.connect(gain)
      gain.connect(this.channelInputs[PERC_CHANNEL]!)
      osc.start(t0)
      try { osc.stop(t0 + 0.4) } catch { /* noop */ }
      endTime = t0 + 0.4
      this.voiceNodes.set(result.voice.id, {
        oscs: [osc], gain, filter: null, filterPkey: null,
        preset: { name: 'perc', wave: 'sine', detune: 0, adsr: { attack: 0.004, decay: 0.35, sustain: 0, release: 0.05 }, cutoff: 0, q: 0.5 },
        peak, t0, endTime,
      })
    } else if (key === 38 || key === 40) {
      endTime = this.percNoiseHit(result.voice.id, t0, peak * 0.75, 1200, 0.18)
    } else if (key === 42 || key === 44) {
      endTime = this.percNoiseHit(result.voice.id, t0, peak * 0.55, 8000, 0.06)
    } else if (key === 46) {
      endTime = this.percNoiseHit(result.voice.id, t0, peak * 0.5, 8000, 0.4)
    } else if (key === 49 || key === 57) {
      endTime = this.percNoiseHit(result.voice.id, t0, peak * 0.5, 5000, 1.2)
    } else {
      endTime = this.percNoiseHit(result.voice.id, t0, peak * 0.4, 3000, 0.1)
    }

    result.voice.released = true
    result.voice.endsAt = endTime
    this.pool.release(result.voice.id)
    this.sweep(t0)
  }

  /** 白噪声打击音（HPF 整形 + 线性包络），返回终止时刻 */
  private percNoiseHit(voiceId: number, t0: number, peak: number, hpf: number, decay: number): number {
    const src = this.ctx.createBufferSource()
    src.buffer = this.noise()
    const bufLen = this.noiseBuffer!.duration
    this.nextNoiseOffset = (this.nextNoiseOffset + 0.311) % 0.9
    const gain = this.ctx.createGain()
    const coeffs = highpassCoeffs(this.ctx.sampleRate, hpf, 0.8)
    const filter = this.acquireFilter(`hpf-${hpf}`, coeffs)
    applyAutomation(gain.gain, [
      { time: t0, value: 0, kind: 'set' },
      { time: t0 + 0.002, value: peak, kind: 'linear-to' },
      { time: t0 + decay, value: 0, kind: 'linear-to' },
    ])
    src.connect(filter || gain)
    if (filter) filter.connect(gain)
    gain.connect(this.channelInputs[PERC_CHANNEL]!)
    src.start(t0, this.nextNoiseOffset * bufLen)
    try { src.stop(t0 + decay + 0.02) } catch { /* noop */ }
    const endTime = t0 + decay + 0.02
    this.voiceNodes.set(voiceId, {
      oscs: [], gain, filter, filterPkey: `hpf-${hpf}`,
      preset: { name: 'perc-noise', wave: 'sine', detune: 0, adsr: { attack: 0.002, decay, sustain: 0, release: 0.02 }, cutoff: 0, q: 0.8 },
      peak, t0, endTime,
    })
    return endTime
  }

  // ---------- 全局控制 ----------

  /** 曲终/停止：快速释放全部语音 + 清踏板状态 */
  allOff(when?: number): void {
    const t = Math.max(when ?? this.ctx.currentTime, this.ctx.currentTime)
    for (const rec of [...(this.pool.list() as VoiceRecord[])]) {
      if (!rec.released) this.releaseVoice(rec, t)
    }
    for (let ch = 0; ch < 16; ch++) {
      this.pedalDown[ch] = false
      this.sustained[ch]!.clear()
    }
  }

  /** 主音量（UI 用，0..1.5） */
  setMasterVolume(v: number): void {
    const t = Math.max(this.ctx.currentTime, 0)
    this.master.gain.setValueAtTime(Math.max(0, Math.min(1.5, v)), t)
  }

  /** 混响发送量（UI 用，0..1） */
  setReverbMix(v: number): void {
    this.reverbSend.gain.setValueAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime)
  }

  /** 主输出旁路 tap（波形可视化用，不影响 destination 链） */
  tapMaster(node: AudioNode): void {
    this.master.connect(node)
  }

  /** M5 装配 Schroeder 混响（reverb.ts 提供，output 经 wet 增益接回 mix） */
  attachReverb(network: { input: AudioNode; output: AudioNode }): void {
    this.reverbSend.connect(network.input)
    const wet = this.ctx.createGain()
    wet.gain.value = REVERB_WET_GAIN
    network.output.connect(wet)
    wet.connect(this.mix)
  }
}

function noteSteal(v: VoiceRecord | undefined): v is VoiceRecord {
  return v !== undefined
}

function noiseFilterCleanup(nodes: VoiceNodes): boolean {
  return nodes.filter !== null && nodes.filterPkey !== null
}
