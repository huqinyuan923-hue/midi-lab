// Web UI：拖 .mid → 波形/钢琴键可视化 + 播放控制 + 音色/混响参数面板 + 离线渲染自检。
// 单文件构建产物（scripts/build-web.mjs 内联），零运行时依赖。

import { parseSmf } from '../smf/parser'
import type { MidiEvent, ParsedSmf } from '../smf/types'
import { Synth } from '../synth/synth'
import { Player } from '../player'
import { buildSchroederReverb } from '../synth/reverb'
import { presetForProgram } from '../synth/presets'

// 调试句柄（页内实验/验收用）
declare global {
  interface Window {
    __midilab: { Synth: typeof Synth; Player: typeof Player; parseSmf: typeof parseSmf; buildSchroederReverb: typeof buildSchroederReverb }
  }
}
window.__midilab = { Synth, Player, parseSmf, buildSchroederReverb }

interface RollNote { startS: number; endS: number; key: number; channel: number; velocity: number }

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

const dropEl = $('drop')
const playBtn = $('play') as HTMLButtonElement
const stopBtn = $('stop') as HTMLButtonElement
const progressEl = $('progress')
const timeEl = $('time')
const rollCanvas = $('roll') as HTMLCanvasElement
const waveCanvas = $('wave') as HTMLCanvasElement
const songsEl = $('songs')
const infoEl = $('info')
const volInput = $('vol') as HTMLInputElement
const revInput = $('rev') as HTMLInputElement
const progSelect = $('prog') as HTMLSelectElement

let audioCtx: AudioContext | null = null
let synth: Synth | null = null
let player: Player | null = null
let parsed: ParsedSmf | null = null
let songName = ''
let rollNotes: RollNote[] = []
let songDuration = 0

// ---------- 音频环境 ----------

async function ensureAudio(): Promise<void> {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    synth = new Synth(audioCtx)
    await synth.ready
    synth.attachReverb(buildSchroederReverb(audioCtx))
    // 波形可视化 tap
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 2048
    synth.tapMaster(analyser)
    ;(window as unknown as { __analyser: AnalyserNode }).__analyser = analyser
  }
  if (audioCtx.state === 'suspended') await audioCtx.resume()
}

// ---------- 曲目加载 ----------

function pairNotes(p: ParsedSmf, secondsAtTick: (t: number) => number): RollNote[] {
  const notes: RollNote[] = []
  for (const track of p.tracks) {
    // 按 (channel,key) 的 noteOn 栈配对
    const open = new Map<string, MidiEvent[]>()
    for (const ev of track) {
      const ck = `${ev.channel}:${ev.data.key}`
      if (ev.type === 'noteOn') {
        const q = open.get(ck) ?? []
        q.push(ev)
        open.set(ck, q)
      } else if (ev.type === 'noteOff') {
        const q = open.get(ck)
        const on = q?.shift()
        if (on) {
          notes.push({
            startS: secondsAtTick(on.tick),
            endS: secondsAtTick(ev.tick),
            key: ev.data.key as number,
            channel: ev.channel ?? 0,
            velocity: on.data.velocity as number,
          })
        }
      }
    }
    // 未关闭的 noteOn：按持有到曲目尾处理
    for (const q of open.values()) {
      for (const on of q) {
        notes.push({ startS: secondsAtTick(on.tick), endS: secondsAtTick(on.tick) + 2, key: on.data.key as number, channel: on.channel ?? 0, velocity: on.data.velocity as number })
      }
    }
  }
  return notes
}

async function loadSong(bytes: Uint8Array, name: string): Promise<void> {
  await ensureAudio()
  if (player) player.stop()
  try {
    parsed = parseSmf(bytes)
  } catch (e) {
    infoEl.textContent = `解析失败：${(e as Error).message}`
    return
  }
  songName = name
  player = new Player(parsed, synth!)
  songDuration = player.duration
  rollNotes = pairNotes(parsed, (t) => player!.secondsAtTick(t))
  playBtn.disabled = false
  stopBtn.disabled = false
  infoEl.textContent = `${name} · format ${parsed.format} · ${parsed.ticksPerQuarter} PPQ · ${parsed.tracks.length} 轨 · ${rollNotes.length} 音符 · 时长 ${fmtTime(songDuration)}`
  drawRoll()
}

// ---------- 钢琴键可视化 ----------

const CHANNEL_COLORS = ['#5ea0f2', '#f2a05e', '#7ee07e', '#e07ee0', '#e0d27e', '#7ee0d2', '#f27e7e', '#a07ef2', '#c8c8c8', '#f2b0c8', '#8fa5ff', '#ffb08f', '#8fffB0', '#b08fff', '#fff08f', '#8ffff0']

function fmtTime(s: number): string {
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

/** 钢琴键图渲染到离屏缓存，帧循环只叠加播放头 */
const rollCache = document.createElement('canvas')

function drawRoll(): void {
  const w = rollCanvas.clientWidth || 900
  const h = rollCanvas.height
  rollCache.width = w
  rollCache.height = h
  const ctx = rollCache.getContext('2d')!
  ctx.fillStyle = '#141922'
  ctx.fillRect(0, 0, w, h)
  if (rollNotes.length === 0 || songDuration === 0) return

  const minKey = Math.max(0, Math.min(...rollNotes.map(n => n.key)) - 2)
  const maxKey = Math.min(127, Math.max(...rollNotes.map(n => n.key)) + 2)
  const keySpan = maxKey - minKey + 1
  const yOf = (k: number): number => h - ((k - minKey + 1) / keySpan) * h

  // 黑白琴键底纹
  for (let k = minKey; k <= maxKey; k++) {
    const isBlack = [1, 3, 6, 8, 10].includes(k % 12)
    ctx.fillStyle = isBlack ? '#10141b' : '#171d27'
    ctx.fillRect(0, yOf(k) - (h / keySpan) + 1, w, h / keySpan - 1)
  }

  for (const n of rollNotes) {
    const x0 = (n.startS / songDuration) * w
    const x1 = ((n.endS + 0.02) / songDuration) * w
    const bw = Math.max(2, x1 - x0)
    const bh = Math.max(3, h / keySpan - 2)
    const alpha = 0.35 + 0.65 * (n.velocity / 127)
    ctx.globalAlpha = alpha
    ctx.fillStyle = CHANNEL_COLORS[n.channel % CHANNEL_COLORS.length]!
    ctx.fillRect(x0, yOf(n.key) - bh, bw, bh)
    ctx.globalAlpha = 1
  }
}

// ---------- 波形 + 播放头渲染循环 ----------

const analyserBuf = new Uint8Array(new ArrayBuffer(2048))
let playing = false

function frame(): void {
  requestAnimationFrame(frame)
  // 波形
  const wctx = waveCanvas.getContext('2d')!
  const w = waveCanvas.clientWidth || 900
  const h = waveCanvas.height
  wctx.fillStyle = '#141922'
  wctx.fillRect(0, 0, w, h)
  const analyser = (window as unknown as { __analyser?: AnalyserNode }).__analyser
  if (analyser && playing) {
    analyser.getByteTimeDomainData(analyserBuf)
    wctx.strokeStyle = '#5ea0f2'
    wctx.beginPath()
    for (let x = 0; x < w; x++) {
      const v = analyserBuf[Math.floor((x / w) * analyserBuf.length)]! / 255
      const y = v * h
      if (x === 0) wctx.moveTo(x, y)
      else wctx.lineTo(x, y)
    }
    wctx.stroke()
  }
  // 钢琴键缓存 + 播放头
  const rctx = rollCanvas.getContext('2d')!
  if (rollCache.width !== (rollCanvas.clientWidth || 900)) drawRoll()
  rctx.drawImage(rollCache, 0, 0)
  if (player && parsed) {
    const pos = player.position
    const d = Math.max(songDuration, 0.001)
    progressEl.style.width = `${Math.min(100, (pos / d) * 100)}%`
    timeEl.textContent = `${fmtTime(pos)} / ${fmtTime(songDuration)}`
    const x = (pos / d) * (rollCanvas.clientWidth || 900)
    rctx.fillStyle = 'rgba(255,255,255,0.3)'
    rctx.fillRect(x, 0, 2, rollCanvas.height)
    if (playing && pos >= songDuration) {
      playing = false
      playBtn.textContent = '▶ 播放'
    }
  }
}
requestAnimationFrame(frame)

// ---------- 交互 ----------

playBtn.addEventListener('click', async () => {
  if (!player) return
  await ensureAudio()
  if (playing) {
    player.stop()
    playing = false
    playBtn.textContent = '▶ 播放'
  } else {
    player.start()
    playing = true
    playBtn.textContent = '⏸ 暂停（重头再播）'
  }
})

stopBtn.addEventListener('click', () => {
  if (player) player.stop()
  playing = false
  playBtn.textContent = '▶ 播放'
})

volInput.addEventListener('input', () => {
  synth?.setMasterVolume(Number(volInput.value) / 100)
})

revInput.addEventListener('input', () => {
  synth?.setReverbMix(Number(revInput.value) / 100)
})

// GM 音色下拉（试音用）
for (let p = 0; p < 128; p++) {
  const opt = document.createElement('option')
  opt.value = String(p)
  opt.textContent = `${p + 1}. ${presetForProgram(p).name}`
  progSelect.appendChild(opt)
}

// 拖拽
document.addEventListener('dragover', e => {
  e.preventDefault()
  dropEl.classList.add('hot')
})
document.addEventListener('dragleave', () => dropEl.classList.remove('hot'))
document.addEventListener('drop', e => {
  e.preventDefault()
  dropEl.classList.remove('hot')
  const file = e.dataTransfer?.files?.[0]
  if (file) void fileToSong(file)
})
dropEl.addEventListener('click', () => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.mid,.midi'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void fileToSong(file)
  }
  input.click()
})

async function fileToSong(file: File): Promise<void> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  await loadSong(bytes, file.name)
}

// 内置测试曲
const BUILT_IN: { name: string; data: string }[] = (window as unknown as { __MIDILAB_SONGS__: { name: string; data: string }[] }).__MIDILAB_SONGS__
BUILT_IN.forEach((song, i) => {
  const btn = document.createElement('button')
  btn.textContent = `♫ 测试曲 ${i + 1}：${song.name}`
  btn.addEventListener('click', () => {
    const bin = atob(song.data)
    const bytes = new Uint8Array(bin.length)
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j)
    void loadSong(bytes, `内置测试曲 ${i + 1}：${song.name}`)
  })
  songsEl.appendChild(btn)
})

// 试音：C 和弦（当前下拉选中的 GM 音色）
$('prelude').addEventListener('click', async () => {
  await ensureAudio()
  const t = audioCtx!.currentTime + 0.05
  const prog = Number(progSelect.value)
  for (const key of [60, 64, 67, 72]) {
    synth!.noteOn(0, key, 100, prog, t)
  }
  for (const key of [60, 64, 67, 72]) {
    synth!.noteOff(0, key, t + 1.2)
  }
})

// ---------- 离线渲染自检（验收 3：音头 <1ms；峰值 <0dBFS；吞吐留档） ----------

/** 构造自检曲目：A4 单音 @1.0s（120bpm PPQ480，noteOn@tick0 → scheduleAllAt(1.0)） */
function selftestSongBytes(): Uint8Array {
  const u32 = (v: number): number[] => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]
  const vi = (v: number): number[] => (v < 0x80 ? [v] : [0x80 | ((v >> 7) & 0x7f), v & 0x7f])
  const chunk = (id: string, body: number[]): number[] => [
    ...[...id].map(c => c.charCodeAt(0)), ...u32(body.length), ...body,
  ]
  const track = [
    ...vi(0), 0x90, 69, 100, // noteOn A4 vel100 @tick0
    ...vi(480), 0x80, 69, 0, // noteOff @tick480
    ...vi(0), 0xff, 0x2f, 0,
  ]
  return Uint8Array.from([
    ...chunk('MThd', [0, 0, 0, 1, 0x01, 0xf4]),
    ...chunk('MTrk', track),
  ])
}

async function renderOffline(bytes: Uint8Array, seconds: number, startAt: number): Promise<AudioBuffer> {
  const sr = 48000
  const off = new OfflineAudioContext(2, Math.ceil(sr * seconds), sr)
  const s = new Synth(off)
  await s.ready
  s.attachReverb(buildSchroederReverb(off))
  const p = new Player(parseSmf(bytes), s)
  p.scheduleAllAt(startAt)
  return off.startRendering()
}

$('run-selftest').addEventListener('click', () => {
  void runSelftest()
})

async function runSelftest(): Promise<void> {
  const out = $('selftest-out')
  out.style.display = 'block'
  out.textContent = '自检运行中…'
  const report: Record<string, unknown> = {}

  try {
    // A. 440Hz 音头精度
    const sr = 48000
    console.log('MIDILAB_SELFTEST stage=A start')
    const buf = await renderOffline(selftestSongBytes(), 2.5, 1.0)
    console.log('MIDILAB_SELFTEST stage=A done')
    const data = buf.getChannelData(0)
    const expectSample = sr // 1.0s
    let onset = -1
    const scanFrom = Math.floor(sr * 0.9)
    for (let i = scanFrom; i < data.length; i++) {
      if (Math.abs(data[i]!) > 0.004) { onset = i; break }
    }
    const errMs = onset < 0 ? null : Math.abs(onset - expectSample) / sr * 1000
    report['音头检测'] = {
      期望采样: expectSample,
      检出采样: onset,
      误差ms: errMs === null ? '未检出' : Number(errMs.toFixed(3)),
      通过: errMs !== null && errMs < 1,
    }

    // B. 整曲离线渲染：峰值 <0dBFS + 吞吐（两首内置曲都验）
    const songResults: Record<string, unknown>[] = []
    let peak = 0
    let songBytes: Uint8Array | null = null
    let songParsed: ParsedSmf | null = null
    let dur = 0
    let si = 0
    for (const song of BUILT_IN) {
      si++
      console.log(`MIDILAB_SELFTEST stage=B${si} start`)
      const bin = atob(song.data)
      const b = new Uint8Array(bin.length)
      for (let j = 0; j < bin.length; j++) b[j] = bin.charCodeAt(j)
      const p = parseSmf(b)
      // duration 探测同样走 Offline（不建实时 AudioContext，避免音频线程互扰）
      const probeCtx = new OfflineAudioContext(2, 128, 48000)
      const probeSynth = new Synth(probeCtx)
      const d = new Player(p, probeSynth).duration
      const t0 = performance.now()
      const buf2 = await renderOffline(b, d + 1.5, 0)
      console.log(`MIDILAB_SELFTEST stage=B${si} rendered ${((performance.now() - t0) / 1000).toFixed(1)}s`)
      const ms = performance.now() - t0
      let pk = 0
      for (let ch = 0; ch < buf2.numberOfChannels; ch++) {
        const dd = buf2.getChannelData(ch)
        for (let i = 0; i < dd.length; i++) {
          const a = Math.abs(dd[i]!)
          if (a > pk) pk = a
        }
      }
      peak = Math.max(peak, pk)
      songResults.push({
        曲目: song.name,
        时长s: Number(d.toFixed(2)),
        渲染耗时ms: Number(ms.toFixed(0)),
        吞吐: `${(d / (ms / 1000)).toFixed(1)}× 实时`,
        峰值dBFS: Number.isFinite(pk) ? Number((20 * Math.log10(pk)).toFixed(2)) : '非有限值',
      })
      if (!songBytes) { songBytes = b; songParsed = p; dur = d }
    }
    report['整曲渲染'] = {
      曲目: songResults,
      全局峰值dBFS: Number.isFinite(peak) ? Number((20 * Math.log10(peak)).toFixed(2)) : '非有限值',
      无削波: Number.isFinite(peak) && peak < 1.0,
    }

    // C. 实时播放帧率留档（8 秒）
    console.log('MIDILAB_SELFTEST stage=C start')
    await ensureAudio()
    console.log('MIDILAB_SELFTEST stage=C audio ready, state=', audioCtx?.state)
    const frames: number[] = []
    let last = performance.now()
    playing = true
    if (player) player.stop()
    player = new Player(songParsed!, synth!)
    songDuration = dur
    rollNotes = pairNotes(songParsed!, t => player!.secondsAtTick(t))
    drawRoll()
    player.start()
    let rafId = 0
    await new Promise<void>(resolve => {
      const loop = (): void => {
        const now = performance.now()
        frames.push(now - last)
        last = now
        rafId = requestAnimationFrame(loop)
      }
      rafId = requestAnimationFrame(loop)
      setTimeout(() => {
        cancelAnimationFrame(rafId)
        resolve()
      }, 8000)
    })
    frames.sort((a, b) => a - b)
    const avg = frames.reduce((s, x) => s + x, 0) / frames.length
    const p95 = frames[Math.floor(frames.length * 0.95)]!
    const max = frames[frames.length - 1]!
    report['实时帧率（8s 采样）'] = {
      帧数: frames.length,
      平均帧ms: Number(avg.toFixed(2)),
      p95帧ms: Number(p95.toFixed(2)),
      最大帧ms: Number(max.toFixed(2)),
    }
    player.stop()
    playing = false
    console.log('MIDILAB_SELFTEST stage=C done')
  } catch (e) {
    report['错误'] = String((e as Error).message ?? e)
  }

  const json = JSON.stringify(report, null, 2)
  out.textContent = json
  console.log('MIDILAB_SELFTEST', json)
  document.title = 'midi-lab · 自检完成'
}
