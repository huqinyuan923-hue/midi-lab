// 主总线软限幅（soft clipper）：保证输出有界 < 1.0（0dBFS）。
// 拓扑：|x| ≤ t 线性直通；|x| > t 分段 tanh 压缩，渐近线 = 1。
// 用原生 WaveShaperNode（曲线域 [-1,1]，超界样本钳到端点 = f(±1) < 1，天然有界）。
// 工程定位：增益管理（gain staging），保证 32 复音最坏叠加不越 0dBFS——任务书验收 4 的前提。

export const SOFT_CLIP_THRESHOLD = 0.85
/** 压缩段渐近线：须 < 1.0（0dBFS），留 2% 余量保证峰值断言严格成立 */
export const SOFT_CLIP_CEILING = 0.98

/** 预计算 WaveShaper 曲线（n 点，域 [-1,1]） */
export function softClipCurve(n = 8192): Float32Array<ArrayBuffer> {
  const t = SOFT_CLIP_THRESHOLD
  const ceiling = SOFT_CLIP_CEILING
  const curve = new Float32Array(new ArrayBuffer(n * 4))
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1 // -1..1
    const ax = Math.abs(x)
    if (ax <= t) {
      curve[i] = x
    } else {
      // tanh 压缩段：斜率连续，渐近线 = ceiling（< 1）
      const y = t + (ceiling - t) * Math.tanh((ax - t) / (ceiling - t))
      curve[i] = Math.sign(x) * y
    }
  }
  return curve
}

/** f(±1) 端点值（超界输入的钳位结果，须 < 1） */
export function softClipEndpoint(): number {
  const t = SOFT_CLIP_THRESHOLD
  const c = SOFT_CLIP_CEILING
  return t + (c - t) * Math.tanh((1 - t) / (c - t))
}
