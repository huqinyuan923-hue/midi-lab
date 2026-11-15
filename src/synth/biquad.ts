// 自写 BiquadFilter 系数（RBJ Audio EQ Cookbook 公式）——任务书要求不用原生 BiquadFilterNode。
// 系数喂给 AudioWorklet 内的差分方程实现（见 worklet-source.ts）。
// 纯数学模块，Node 端可数值验证频率响应。

export interface BiquadCoeffs {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/**
 * 二阶低通（RBJ cookbook §3.1 "LPF"），Q 为品质因数（0.5~2 实用区）。
 * 返回已按 a0 归一化的系数。
 */
export function lowpassCoeffs(sampleRate: number, f0: number, q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * Math.min(f0, sampleRate / 2 * 0.98) / sampleRate
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.0001))
  const cosW0 = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: (1 - cosW0) / 2 / a0,
    b1: (1 - cosW0) / a0,
    b2: (1 - cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  }
}

/** 二阶高通（RBJ cookbook §3.2 "HPF"）——打击乐噪声整形用 */
export function highpassCoeffs(sampleRate: number, f0: number, q: number): BiquadCoeffs {
  const w0 = 2 * Math.PI * Math.min(f0, sampleRate / 2 * 0.98) / sampleRate
  const alpha = Math.sin(w0) / (2 * Math.max(q, 0.0001))
  const cosW0 = Math.cos(w0)
  const a0 = 1 + alpha
  return {
    b0: (1 + cosW0) / 2 / a0,
    b1: (-(1 + cosW0)) / a0,
    b2: (1 + cosW0) / 2 / a0,
    a1: (-2 * cosW0) / a0,
    a2: (1 - alpha) / a0,
  }
}

/**
 * 数值频率响应：|H(e^{jw})| 与相位。
 * H(z) = (b0 + b1 z^-1 + b2 z^-2) / (1 + a1 z^-1 + a2 z^-2)
 */
export function biquadResponse(
  c: BiquadCoeffs, freq: number, sampleRate: number,
): { magnitude: number; phase: number } {
  const w = 2 * Math.PI * freq / sampleRate
  const z1r = Math.cos(w), z1i = -Math.sin(w)            // z^-1
  const z2r = Math.cos(2 * w), z2i = -Math.sin(2 * w)    // z^-2
  // 分子/分母复数值
  const nr = c.b0 + c.b1 * z1r + c.b2 * z2r
  const ni = c.b1 * z1i + c.b2 * z2i
  const dr = 1 + c.a1 * z1r + c.a2 * z2r
  const di = c.a1 * z1i + c.a2 * z2i
  // 复数除法
  const denom = dr * dr + di * di
  const hr = (nr * dr + ni * di) / denom
  const hi = (ni * dr - nr * di) / denom
  return { magnitude: Math.hypot(hr, hi), phase: Math.atan2(hi, hr) }
}

/** 直接 I 型差分方程一步（worklet 实现的参考语义，用于对照测试） */
export function biquadProcessSample(c: BiquadCoeffs, state: { x1: number; x2: number; y1: number; y2: number }, x: number): number {
  const y = c.b0 * x + c.b1 * state.x1 + c.b2 * state.x2 - c.a1 * state.y1 - c.a2 * state.y2
  state.x2 = state.x1
  state.x1 = x
  state.y2 = state.y1
  state.y1 = y
  return y
}
