// 测试专用 Fake AudioContext（仅 tests/ 使用）：记录 automation 与节点拓扑，
// 供合成器/播放器在 Node 端做调度精度验证。零运行时依赖纪律不适用于测试辅助。

export interface FakeAutomationEvent {
  type: 'set' | 'linear' | 'exponential' | 'cancel'
  time: number
  value: number
}

export class FakeAudioParam {
  value = 0
  readonly events: FakeAutomationEvent[] = []
  setValueAtTime(v: number, t: number): void {
    this.events.push({ type: 'set', time: t, value: v })
  }
  linearRampToValueAtTime(v: number, t: number): void {
    this.events.push({ type: 'linear', time: t, value: v })
  }
  exponentialRampToValueAtTime(v: number, t: number): void {
    this.events.push({ type: 'exponential', time: t, value: v })
  }
  cancelScheduledValues(t: number): void {
    // Web Audio 语义：移除 time >= t 的所有事件（测试断言依赖真实语义）
    for (let i = this.events.length - 1; i >= 0; i--) {
      if (this.events[i]!.time >= t) this.events.splice(i, 1)
    }
    this.events.push({ type: 'cancel', time: t, value: NaN })
  }
  /** 简化求值：忽略 ramp 插值细节，取 <= time 的最后一个事件值 */
  valueAt(t: number): number {
    let v = this.value
    for (const e of this.events) {
      if (e.type === 'cancel') continue
      if (e.time <= t) v = e.value
    }
    return v
  }
}

export class FakeAudioNode {
  readonly kind: string
  readonly params: Record<string, FakeAudioParam> = {}
  readonly connections: FakeAudioNode[] = []
  periodicWave: { real: Float32Array; imag: Float32Array } | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null
  startOffset = 0
  onended: (() => void) | null = null
  options: unknown

  constructor(kind: string) {
    this.kind = kind
  }

  param(name: string): FakeAudioParam {
    const p = this.params[name] ?? new FakeAudioParam()
    this.params[name] = p
    return p
  }

  /** 标准 Web Audio 参数访问器（Synth 直接 node.gain / node.frequency 访问） */
  get gain(): FakeAudioParam {
    return this.param('gain')
  }
  get frequency(): FakeAudioParam {
    return this.param('frequency')
  }
  get detune(): FakeAudioParam {
    return this.param('detune')
  }
  get pan(): FakeAudioParam {
    return this.param('pan')
  }
  get delayTime(): FakeAudioParam {
    return this.param('delayTime')
  }
  get playbackRate(): FakeAudioParam {
    return this.param('playbackRate')
  }
  buffer: { duration: number; getChannelData(ch: number): Float32Array } | null = null

  connect(node: FakeAudioNode): void {
    this.connections.push(node)
  }

  disconnect(): void {
    this.connections.length = 0
  }

  start(t?: number, offset?: number): void {
    this.startedAt = t ?? 0
    this.startOffset = offset ?? 0
  }

  stop(t?: number): void {
    if (this.stoppedAt === null) this.stoppedAt = t ?? 0
    // Web Audio 语义：double-stop 抛 InvalidStateError；这里模拟
    else throw new Error('InvalidStateError: stop already called')
  }

  setPeriodicWave(w: { real: Float32Array; imag: Float32Array }): void {
    this.periodicWave = w
  }
}

export class FakeAudioContext {
  currentTime = 0
  readonly sampleRate = 48000
  readonly destination = new FakeAudioNode('destination')
  readonly nodes: FakeAudioNode[] = []
  readonly periodicWaves: { real: Float32Array; imag: Float32Array }[] = []
  readonly audioWorklet = {
    addModule: async (): Promise<void> => { /* 记录即可 */ },
  }

  createGain(): FakeAudioNode {
    const n = new FakeAudioNode('gain')
    this.nodes.push(n)
    return n
  }

  createOscillator(): FakeAudioNode {
    const n = new FakeAudioNode('oscillator')
    this.nodes.push(n)
    return n
  }

  createStereoPanner(): FakeAudioNode {
    const n = new FakeAudioNode('stereo-panner')
    this.nodes.push(n)
    return n
  }

  createBufferSource(): FakeAudioNode {
    const n = new FakeAudioNode('buffer-source')
    this.nodes.push(n)
    return n
  }

  createDelay(maxDelayTime?: number): FakeAudioNode {
    const n = new FakeAudioNode('delay')
    n.param('delayTime').value = maxDelayTime ?? 0
    this.nodes.push(n)
    return n
  }

  createWaveShaper(): FakeAudioNode & { curve: Float32Array | null; oversample: string } {
    const n = new FakeAudioNode('waveshaper') as FakeAudioNode & { curve: Float32Array | null; oversample: string }
    n.curve = null
    n.oversample = 'none'
    this.nodes.push(n)
    return n
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    return new FakeAudioBuffer(channels, length, sampleRate)
  }

  createPeriodicWave(real: Float32Array, imag: Float32Array): { real: Float32Array; imag: Float32Array } {
    const w = { real, imag }
    this.periodicWaves.push(w)
    return w
  }

  /** 推进虚拟时钟（测试调度循环用） */
  advance(seconds: number): void {
    this.currentTime += seconds
  }

  /** 找出所有已 start 的振荡器 */
  oscillators(): FakeAudioNode[] {
    return this.nodes.filter(n => n.kind === 'oscillator')
  }
}

export class FakeAudioBuffer {
  constructor(readonly channels: number, readonly length: number, readonly sampleRate: number) {}
  get duration(): number {
    return this.length / this.sampleRate
  }
  getChannelData(_ch: number): Float32Array {
    return new Float32Array(this.length)
  }
}
