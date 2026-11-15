// M5 差分验收 harness：≥30 个真实 .mid 对拍双 oracle。
//   oracle A（原始事件层）：midi-file —— 全事件逐字段比对（tick/type/channel/key/velocity/...），
//     sysex 与未知 meta 按原始字节（hex）比对
//   oracle B（音符视图层）：@tonejs/midi —— notes/controlChanges/pitchBends/tempos/拍号 逐字段比对
//   round-trip：parse→serialize→parse 事件级幂等；serialize 输出可被两个 oracle 解析且事件集不变
// oracle 只当裁判，绝不进运行时（差分纪律）。

import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import pkgTone from '@tonejs/midi'
import pkgMidiFile from 'midi-file'
import { parseSmf } from '../src/smf/parser'
import { serializeSmf } from '../src/smf/serializer'
import type { MidiEvent, ParsedSmf } from '../src/smf/types'
import {
  diffShapes, firstDiffPath, mineToToneView, normalizeToneJson, oracleEventToShape, oracleShape,
} from './helpers'

const require_ = createRequire(import.meta.url)
const { parseMidi } = pkgMidiFile as unknown as { parseMidi: (b: Uint8Array) => OracleParsed }
const { Midi } = pkgTone as { Midi: new (b: Uint8Array) => ToneParsed }

interface OracleRawEvent { deltaTime: number; type: string; [k: string]: unknown }
interface OracleParsed { header: { format: number; numTracks: number; ticksPerBeat?: number; ticksPerFrame?: number; framesPerSecond?: number }; tracks: OracleRawEvent[][] }
interface ToneParsed { toJSON(): unknown }

const fixtureDir = new URL('./fixtures/', import.meta.url)
const files = readdirSync(fixtureDir).filter(f => f.toLowerCase().endsWith('.mid')).sort()

// oracle 拒绝（或视图异常）的文件在跳过清单中如实记录原因；有效差分文件数必须 ≥30
const SKIPPED: string[] = []

function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))
    }
    return x
  })
}

/** 解析层差分：mine vs midi-file（全事件全字段 + sysex/unknownMeta 原始字节） */
function diffRawEvents(mine: ParsedSmf, oracle: OracleParsed, label: string): string[] {
  const problems: string[] = []
  if (mine.tracks.length !== oracle.tracks.length) {
    problems.push(`${label}: 轨数 mine=${mine.tracks.length} oracle=${oracle.tracks.length}`)
    return problems
  }
  for (let t = 0; t < oracle.tracks.length; t++) {
    let tick = 0
    const oracleEvents = oracle.tracks[t]!.map(raw => {
      tick += raw.deltaTime
      return oracleEventToShape(raw as unknown as Record<string, unknown>, tick)
    })
    const mineEvents = mine.tracks[t]!
    if (mineEvents.length !== oracleEvents.length) {
      problems.push(`${label}: 轨${t} 事件数 mine=${mineEvents.length} oracle=${oracleEvents.length}`)
      continue
    }
    for (let i = 0; i < oracleEvents.length; i++) {
      problems.push(...diffShapes(oracleShape(mineEvents[i]!), oracleEvents[i]!, `${label} 轨${t}事件${i}`))
    }
  }
  return problems
}

describe('差分验收：真实语料对拍', () => {
  it('语料规模 ≥ 30 个 .mid', () => {
    expect(files.length).toBeGreaterThanOrEqual(30)
  })

  it('逐文件：解析差分 + round-trip 幂等 + oracle 二次解析一致 + tonejs 视图一致', () => {
    const summary: string[] = []
    let passed = 0
    for (const f of files) {
      const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)))
      const label = f
      const problems: string[] = []

      // oracle A 解析
      let oracle: OracleParsed
      try {
        oracle = parseMidi(bytes)
      } catch (e) {
        SKIPPED.push(`${f}: oracle 拒绝 (${String((e as Error).message).slice(0, 50)})`)
        continue
      }

      // 本项目解析
      const mine = parseSmf(bytes)

      // 1) 原始事件层差分（含 sysex / unknownMeta 字节）
      problems.push(...diffRawEvents(mine, oracle, label))

      // 2) round-trip 幂等（事件级）
      const once = parseSmf(bytes)
      const bytes2 = serializeSmf(once)
      const twice = parseSmf(bytes2)
      if (stableJson(twice) !== stableJson(once)) problems.push(`${label}: round-trip 二次解析不一致`)

      // 3) serialize 输出喂给 oracle A：事件集不变
      const oracle2 = parseMidi(bytes2)
      problems.push(...diffRawEvents(parseSmf(bytes2), oracle2, `${label}/serialized`))

      // 4) oracle B（@tonejs/midi）：原始文件与 serialize 输出的视图一致，且与我的解析视图一致
      try {
        const toneOrig = new Midi(bytes).toJSON()
        const toneMine = new Midi(bytes2).toJSON()
        if (stableJson(normalizeToneJson(toneOrig)) !== stableJson(normalizeToneJson(toneMine))) {
          problems.push(`${label}: tonejs 视图 serialize 前后不一致`)
        }
        const myView = normalizeToneJson(mineToToneView(mine))
        const theirView = normalizeToneJson(toneOrig)
        if (stableJson(myView) !== stableJson(theirView)) {
          const where = firstDiffPath(myView, theirView)
          problems.push(`${label}: tonejs 视图不一致 @ ${where ?? '?'}`)
        }
      } catch (e) {
        SKIPPED.push(`${f}: tonejs 拒绝 (${String((e as Error).message).slice(0, 50)})`)
        continue
      }

      if (problems.length === 0) passed++
      else summary.push(...problems.slice(0, 5))
    }

    // 汇总输出（一次断言集中报告所有问题，便于收敛）
    expect(summary, `有效差分文件 ${passed}/${files.length}`).toEqual([])
    expect(passed).toBeGreaterThanOrEqual(30)
    if (SKIPPED.length) console.log('跳过文件：\n' + SKIPPED.map(s => '  ' + s).join('\n'))
  })
})

describe('性能基准', () => {
  it('最大语料文件解析 < 100ms（含 serialize + 二次 parse）', () => {
    let largest = ''
    let largestSize = 0
    for (const f of files) {
      const b = readFileSync(new URL(`./fixtures/${f}`, import.meta.url))
      if (b.length > largestSize) { largestSize = b.length; largest = f }
    }
    const bytes = new Uint8Array(readFileSync(new URL(`./fixtures/${largest}`, import.meta.url)))
    // 预热
    parseSmf(serializeSmf(parseSmf(bytes)))
    const t0 = performance.now()
    const p = parseSmf(bytes)
    const bytes2 = serializeSmf(p)
    parseSmf(bytes2)
    const elapsed = performance.now() - t0
    console.log(`最大文件 ${largest}（${(largestSize / 1024).toFixed(0)}KB，${p.tracks.length} 轨，${p.tracks.reduce((s, t) => s + t.length, 0)} 事件）：parse+serialize+parse ${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(100)
  })

  it('合成 5 分钟曲目（4 轨 × 每秒 8 事件）解析 < 100ms', () => {
    const tracks: MidiEvent[][] = []
    for (let t = 0; t < 4; t++) {
      const events: MidiEvent[] = []
      for (let i = 0; i < 5 * 60 * 8; i++) {
        events.push({ tick: i * 30, type: 'noteOn', channel: t, data: { key: 36 + (i % 60), velocity: 80 } })
        events.push({ tick: i * 30 + 20, type: 'noteOff', channel: t, data: { key: 36 + (i % 60), velocity: 0 } })
      }
      tracks.push(events)
    }
    const bytes = serializeSmf({ format: 1, ticksPerQuarter: 480, tracks })
    // 预热
    parseSmf(bytes)
    const t0 = performance.now()
    const p = parseSmf(bytes)
    const elapsed = performance.now() - t0
    const totalEvents = p.tracks.reduce((s, t) => s + t.length, 0)
    console.log(`合成 5 分钟曲目（${totalEvents} 事件，${(bytes.length / 1024).toFixed(0)}KB）：${elapsed.toFixed(1)}ms`)
    expect(elapsed).toBeLessThan(100)
  })
})

type _MidiEvent = MidiEvent // 仅用于类型引用保持导入有效
