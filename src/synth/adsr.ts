// ADSR 包络（线性段）：纯调度计划计算，Node 可测。
// Synth 层把计划翻译成 GainNode automation（setValueAtTime + linearRampToValueAtTime）。
// 设计要点：release 不重起坡——从上一个 automation 事件值线性滑到 0，
// 连续无跳变（无爆音），且调度时间完全可预计算。

export interface AdsrParams {
  attack: number   // 起音秒数（>0；0 视为瞬时）
  decay: number    // 衰减秒数
  sustain: number  // 持续电平 0..1（相对峰值）
  release: number  // 释放秒数
}

export interface AutomationEvent {
  /** 绝对 AudioContext 时间（秒） */
  time: number
  value: number
  kind: 'set' | 'linear-to'
}

/** noteOn 时刻 t0、峰值 peak：起音 + 衰减段（sustain 段后由 noteOff 触发） */
export function planAttack(params: AdsrParams, peak: number, t0: number): AutomationEvent[] {
  const events: AutomationEvent[] = []
  const a = Math.max(params.attack, 0.001)
  const d = Math.max(params.decay, 0)
  events.push({ time: t0, value: 0, kind: 'set' })
  events.push({ time: t0 + a, value: peak, kind: 'linear-to' })
  if (d > 0 && params.sustain < 1) {
    events.push({ time: t0 + a + d, value: peak * params.sustain, kind: 'linear-to' })
  }
  return events
}

/** noteOff 时刻 tOff：释放段（从上一事件值滑到 0）；返回 automation 与语音终止时刻 */
export function planRelease(params: AdsrParams, tOff: number): { events: AutomationEvent[]; endTime: number } {
  const r = Math.max(params.release, 0.005)
  return {
    events: [{ time: tOff + r, value: 0, kind: 'linear-to' }],
    endTime: tOff + r,
  }
}

/** 被偷音/同 key 重触发的快速淡出（不读当前值，从上一事件值滑到 0） */
export function planStealFade(tNow: number, fade = 0.015): { events: AutomationEvent[]; endTime: number } {
  return {
    events: [{ time: tNow + fade, value: 0, kind: 'linear-to' }],
    endTime: tNow + fade,
  }
}

/** 语音从 noteOn 起不会越过 noteOff 的最晚时间（osc.stop 上界用：noteOff 未到时给足余量） */
export function voiceDeadline(params: AdsrParams, t0: number, maxDuration: number): number {
  return t0 + Math.max(params.attack, 0.001) + Math.max(params.decay, 0) + maxDuration
}
