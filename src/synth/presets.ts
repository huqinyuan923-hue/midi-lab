// GM 音色粗映射表：128 个 GM program → 一期减法合成参数（波形 + ADSR + 滤波）。
// "每声道 16 音色预设" 按任务书精神实现为按 GM 音色家族的粗分桶（钢琴/风琴/弦乐/贝斯…）。
// 1983 年规格冻结：只做一期粗映射，不做采样。

import type { AdsrParams } from './adsr'
import type { WaveType } from './waves'

export interface Preset {
  name: string
  wave: WaveType
  /** 两个振荡器失谐（音色厚度）；0 = 单振荡器 */
  detune: number
  adsr: AdsrParams
  /** 低通截止频率（Hz）；0 = 不滤波 */
  cutoff: number
  /** 滤波 Q */
  q: number
}

// GM program（0 起）家族分界：
// 0-7 钢琴类 / 8-15 半打击/钟琴 / 16-23 风琴 / 24-31 吉他 / 32-39 贝斯 /
// 40-47 弦乐 / 48-55 合奏 / 56-63 铜管 / 64-71 簧片 / 72-79 笛类 / 80-95 合成器 / 96-103 打击效果 / 其余音效
const PRESETS: Record<string, Preset> = {
  piano: { name: '钢琴', wave: 'sawtooth', detune: 0, adsr: { attack: 0.003, decay: 0.6, sustain: 0.25, release: 0.18 }, cutoff: 5200, q: 0.6 },
  brightPiano: { name: '亮钢琴', wave: 'square', detune: 0, adsr: { attack: 0.003, decay: 0.55, sustain: 0.28, release: 0.18 }, cutoff: 6000, q: 0.6 },
  bell: { name: '钟琴类', wave: 'sine', detune: 4, adsr: { attack: 0.002, decay: 1.2, sustain: 0.0, release: 0.6 }, cutoff: 0, q: 0.5 },
  organ: { name: '风琴', wave: 'square', detune: 0, adsr: { attack: 0.01, decay: 0.05, sustain: 0.95, release: 0.08 }, cutoff: 4800, q: 0.7 },
  guitar: { name: '吉他', wave: 'sawtooth', detune: 3, adsr: { attack: 0.004, decay: 0.45, sustain: 0.22, release: 0.2 }, cutoff: 4200, q: 0.8 },
  bass: { name: '贝斯', wave: 'sawtooth', detune: 0, adsr: { attack: 0.005, decay: 0.3, sustain: 0.5, release: 0.12 }, cutoff: 1100, q: 0.9 },
  synthBass: { name: '合成贝斯', wave: 'square', detune: 0, adsr: { attack: 0.004, decay: 0.25, sustain: 0.45, release: 0.1 }, cutoff: 900, q: 1.1 },
  strings: { name: '弦乐', wave: 'sawtooth', detune: 7, adsr: { attack: 0.09, decay: 0.3, sustain: 0.85, release: 0.35 }, cutoff: 3400, q: 0.6 },
  slowPad: { name: '铺底', wave: 'triangle', detune: 9, adsr: { attack: 0.25, decay: 0.4, sustain: 0.8, release: 0.5 }, cutoff: 2600, q: 0.5 },
  brass: { name: '铜管', wave: 'sawtooth', detune: 5, adsr: { attack: 0.05, decay: 0.2, sustain: 0.7, release: 0.18 }, cutoff: 3800, q: 0.9 },
  reed: { name: '簧片', wave: 'square', detune: 4, adsr: { attack: 0.04, decay: 0.15, sustain: 0.75, release: 0.15 }, cutoff: 4200, q: 0.8 },
  flute: { name: '笛类', wave: 'sine', detune: 0, adsr: { attack: 0.06, decay: 0.1, sustain: 0.85, release: 0.2 }, cutoff: 0, q: 0.5 },
  synthLead: { name: '合成主音', wave: 'square', detune: 6, adsr: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.15 }, cutoff: 5500, q: 1.0 },
  synthPad: { name: '合成铺底', wave: 'triangle', detune: 8, adsr: { attack: 0.15, decay: 0.5, sustain: 0.75, release: 0.4 }, cutoff: 3000, q: 0.6 },
  ethnic: { name: '民族/拨弦', wave: 'triangle', detune: 0, adsr: { attack: 0.003, decay: 0.5, sustain: 0.15, release: 0.3 }, cutoff: 3600, q: 0.7 },
  fx: { name: '音效/打击', wave: 'sine', detune: 0, adsr: { attack: 0.01, decay: 0.4, sustain: 0.3, release: 0.25 }, cutoff: 4000, q: 0.7 },
}

/** 按 GM program（0..127）映射到预设桶 */
export function presetForProgram(program: number): Preset {
  const p = ((Math.floor(program) % 128) + 128) % 128
  if (p <= 7) return p <= 2 ? PRESETS.piano! : p <= 4 ? PRESETS.brightPiano! : p <= 6 ? PRESETS.ethnic! : PRESETS.brightPiano!
  if (p <= 15) return PRESETS.bell!
  if (p <= 23) return PRESETS.organ!
  if (p <= 31) return PRESETS.guitar!
  if (p <= 39) return p <= 36 ? PRESETS.bass! : PRESETS.synthBass!
  if (p <= 47) return PRESETS.strings!
  if (p <= 55) return PRESETS.slowPad!
  if (p <= 63) return PRESETS.brass!
  if (p <= 71) return PRESETS.reed!
  if (p <= 79) return PRESETS.flute!
  if (p <= 95) return p <= 87 ? PRESETS.synthLead! : PRESETS.synthPad!
  return PRESETS.fx!
}

/** 预设键名 → 系数（AudioWorklet 节点池按预设分池需要唯一键） */
export function presetKey(program: number): string {
  const preset = presetForProgram(program)
  return `${preset.wave}-${preset.detune}-${preset.adsr.attack}-${preset.adsr.decay}-${preset.adsr.sustain}-${preset.adsr.release}-${preset.cutoff}-${preset.q}`
}
