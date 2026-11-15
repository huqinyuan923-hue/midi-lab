// AudioWorklet 处理器源码（字符串内联，经 Blob URL 加载——零依赖单文件打包的关键）。
// 自写 BiquadFilter 差分方程：任务书要求不用原生 BiquadFilterNode，系数由 src/synth/biquad.ts 推导。
// 系数经 processorOptions 传入（同步、无消息延迟），处理单声道信号。

export const BIQUAD_WORKLET_CODE = String.raw`
class BiquadProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const c = (options && options.processorOptions) || {};
    this.b0 = typeof c.b0 === 'number' ? c.b0 : 1;
    this.b1 = c.b1 || 0;
    this.b2 = c.b2 || 0;
    this.a1 = c.a1 || 0;
    this.a2 = c.a2 || 0;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
    this.port.onmessage = (e) => {
      if (e.data && e.data.reset) { this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0; }
    };
  }
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const x = input[0];
    const y = output[0];
    const b0 = this.b0, b1 = this.b1, b2 = this.b2, a1 = this.a1, a2 = this.a2;
    let x1 = this.x1, x2 = this.x2, y1 = this.y1, y2 = this.y2;
    for (let i = 0; i < x.length; i++) {
      const xn = x[i];
      const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      y[i] = yn;
    }
    this.x1 = x1; this.x2 = x2; this.y1 = y1; this.y2 = y2;
    return true;
  }
}
registerProcessor('midi-lab-biquad', BiquadProcessor);

// 主总线软限幅（soft-clip.ts 的同公式内联版）：|x|<=t 直通，>t 分段 tanh，渐近线 0.98 < 1。
// 每 128 样本块直接逐样本处理（比 WaveShaper 大曲线 + oversample 便宜一个数量级）。
const CLIP_T = 0.85;
const CLIP_CEIL = 0.98;
const CLIP_K = CLIP_CEIL - CLIP_T;
class MasterClipProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || !output[0]) return true;
    for (let ch = 0; ch < output.length; ch++) {
      const inp = input && input[ch] ? input[ch] : null;
      const out = output[ch];
      for (let i = 0; i < out.length; i++) {
        const x = inp ? inp[i] : 0;
        const ax = x < 0 ? -x : x;
        if (ax <= CLIP_T) {
          out[i] = x;
        } else {
          out[i] = (x < 0 ? -1 : 1) * (CLIP_T + CLIP_K * Math.tanh((ax - CLIP_T) / CLIP_K));
        }
      }
    }
    return true;
  }
}
registerProcessor('midi-lab-master', MasterClipProcessor);
`;

/** worklet 模块 URL（浏览器端：Blob URL；离线渲染同样可用） */
export function createBiquadWorkletUrl(): string {
  return URL.createObjectURL(new Blob([BIQUAD_WORKLET_CODE], { type: 'application/javascript' }))
}
