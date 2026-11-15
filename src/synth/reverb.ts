// Schroeder 混响（1961/1970 年代拓扑，规格同样冻结）：
// 4 并联梳状（comb）滤波器 → 2 串联全通（allpass）滤波器。
// 全部用原生 DelayNode + GainNode 反馈网络实现（comb: y=x[n-D]+g·y[n-D]；
// allpass: y=-g·x[n]+x[n-D]+g·y[n-D]，输出回喂 delay 输入端实现）。

export interface ReverbNetwork {
  input: AudioNode
  output: AudioNode
}

/** 经典 Schroeder 参数（秒 / 反馈系数） */
const COMB_DELAYS_S = [0.0297, 0.0371, 0.0411, 0.0437]
const COMB_FEEDBACK = [0.805, 0.827, 0.849, 0.871]
const ALLPASS_DELAYS_S = [0.005, 0.0017]
const ALLPASS_GAIN = 0.7

export function buildSchroederReverb(ctx: BaseAudioContext): ReverbNetwork {
  const input = ctx.createGain()
  const combSum = ctx.createGain()
  combSum.gain.value = 1 / 4 // 并联求和归一：抑制梳状共振峰（1/(1-g)≈7.75）直接叠乘

  // 4 并联 comb
  for (let i = 0; i < COMB_DELAYS_S.length; i++) {
    const delay = ctx.createDelay(0.1)
    delay.delayTime.value = COMB_DELAYS_S[i]!
    const fb = ctx.createGain()
    fb.gain.value = COMB_FEEDBACK[i]!
    input.connect(delay)
    delay.connect(combSum)
    delay.connect(fb)
    fb.connect(delay) // 反馈环（含 DelayNode，合法循环）
  }

  // 2 串联 allpass
  let apInput: AudioNode = combSum
  let apOutput: AudioNode | null = null
  for (const dS of ALLPASS_DELAYS_S) {
    const sum = ctx.createGain()          // 输出节点
    const delay = ctx.createDelay(0.05)
    delay.delayTime.value = dS
    const inv = ctx.createGain()
    inv.gain.value = -ALLPASS_GAIN
    const fb = ctx.createGain()
    fb.gain.value = ALLPASS_GAIN

    apInput.connect(delay)
    delay.connect(sum)                    // x[n-D]
    apInput.connect(inv)
    inv.connect(sum)                      // -g·x[n]
    sum.connect(fb)
    fb.connect(delay)                     // 输出回喂 delay：delay 输入 = x + g·y
    apInput = sum
    apOutput = sum
  }

  return { input, output: apOutput! }
}
