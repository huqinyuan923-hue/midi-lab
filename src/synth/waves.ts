// 波形傅里叶系数：方波/锯齿/三角/正弦的 additive 合成系数。
// 纯数学模块（Node 可测）；Synth 层用 ctx.createPeriodicWave(real, imag) 消费。
// 不使用原生 osc type —— 任务书要求自写 PeriodicWave 系数。

export type WaveType = 'square' | 'sawtooth' | 'triangle' | 'sine'

/**
 * 计算前 harmonics 个谐波的傅里叶系数。
 * Web Audio PeriodicWave 约定：x(t) = Σ (real[n]·cos(2πnt/T) + imag[n]·sin(2πnt/T))
 * 系数按标准波形数学定义（峰值归一到 ±1 附近）：
 *   - 正弦：imag[1] = 1
 *   - 方波：imag[奇次 n] = 4/(πn)
 *   - 锯齿：imag[n] = (-1)^(n+1) · 2/(πn)
 *   - 三角：imag[奇次 n] = (-1)^((n-1)/2) · 8/(π²n²)
 * n=0 项恒为 0（无直流分量）。
 */
export function waveCoefficients(type: WaveType, harmonics: number): { real: Float32Array; imag: Float32Array } {
  const real = new Float32Array(harmonics + 1)
  const imag = new Float32Array(harmonics + 1)
  const put = (n: number, b: number): void => { imag[n] = b }

  switch (type) {
    case 'sine':
      put(1, 1)
      break
    case 'square':
      for (let n = 1; n <= harmonics; n += 2) put(n, 4 / (Math.PI * n))
      break
    case 'sawtooth':
      for (let n = 1; n <= harmonics; n++) put(n, (n % 2 === 1 ? 1 : -1) * (2 / (Math.PI * n)))
      break
    case 'triangle':
      for (let n = 1; n <= harmonics; n += 2) {
        const k = (n - 1) / 2
        put(n, (k % 2 === 0 ? 1 : -1) * (8 / (Math.PI * Math.PI * n * n)))
      }
      break
  }
  return { real, imag }
}

/** 按基频选择谐波数上限：避免高频谐波越过 Nyquist 产生混叠（三档策略） */
export function harmonicBudget(sampleRate: number, freq: number): number {
  const nyquist = sampleRate / 2
  const budget = Math.floor(nyquist / Math.max(freq, 1))
  // 三档表：低频 64、中频 32、高频 16 谐波
  if (budget >= 64) return 64
  if (budget >= 32) return 32
  return Math.max(budget, 8)
}

/** MIDI 音符编号 → 频率（A4=69 = 440Hz，十二平均律） */
export function midiKeyToFreq(key: number): number {
  return 440 * 2 ** ((key - 69) / 12)
}
