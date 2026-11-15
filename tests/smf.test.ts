// M1 单元测试：手造 SMF 字节覆盖全部事件类型、running status、round-trip、坏文件。
// 同时与 oracle（midi-file）做逐字段差分，保证手造文件口径一致。

import { describe, expect, it } from 'vitest'
import { parseMidi } from 'midi-file'
import { parseSmf } from '../src/smf/parser'
import { serializeSmf } from '../src/smf/serializer'
import type { MidiEvent, ParsedSmf } from '../src/smf/types'
import {
  chunk, diffShapes, ev, mthd, mtrk, oracleEventToShape, oracleShape, smf,
} from './helpers'

/** 我的解析结果与 oracle parseMidi 逐事件逐字段差分，返回问题列表 */
function diffAgainstOracle(bytes: Uint8Array): string[] {
  const mine = parseSmf(bytes)
  const oracle = parseMidi(bytes)
  const problems: string[] = []
  expect(mine.tracks.length).toBe(oracle.tracks.length)
  for (let t = 0; t < oracle.tracks.length; t++) {
    let tick = 0
    const oracleEvents = oracle.tracks[t]!.map(raw => {
      tick += raw.deltaTime as number
      return oracleEventToShape(raw as unknown as Record<string, unknown>, tick)
    })
    const mineEvents = mine.tracks[t]!
    expect(mineEvents.length).toBe(oracleEvents.length)
    for (let i = 0; i < oracleEvents.length; i++) {
      problems.push(...diffShapes(oracleShape(mineEvents[i]!), oracleEvents[i]!, `轨${t}事件${i}`))
    }
  }
  return problems
}

/** 事件级幂等：parse(serialize(parse(bytes))) 与 parse(bytes) 深度一致 */
function expectRoundTripIdempotent(bytes: Uint8Array): void {
  const once = parseSmf(bytes)
  const bytes2 = serializeSmf(once)
  const twice = parseSmf(bytes2)
  expect(stableJson(twice)).toBe(stableJson(once))
  // serialize 再跑一次应得到完全相同的字节（确定性）
  expect(serializeSmf(parseSmf(bytes2))).toEqual(bytes2)
}

/** 排序键的稳定 JSON（data 的键序可能因构造路径不同而不同） */
function stableJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) {
      return Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1))
    }
    return x
  })
}

describe('SMF 解析：基本事件', () => {
  it('format 0 最小文件：noteOn/noteOff/EoT', () => {
    const bytes = smf([[
      ...ev(0, 0x90, 60, 100),
      ...ev(96, 0x80, 60, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]], 0)
    const p = parseSmf(bytes)
    expect(p.format).toBe(0)
    expect(p.ticksPerQuarter).toBe(480)
    expect(p.tracks).toHaveLength(1)
    const events = p.tracks[0]!
    expect(events.map(e => [e.tick, e.type])).toEqual([
      [0, 'noteOn'], [96, 'noteOff'], [96, 'endOfTrack'],
    ])
    expect(events[0]).toMatchObject({ channel: 0, data: { key: 60, velocity: 100 } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('全部通道事件类型（两字节/一字节事件、pitch bend 归一化）', () => {
    const bytes = smf([[
      ...ev(0, 0x90, 60, 100),
      ...ev(0, 0x80, 60, 64),
      ...ev(0, 0x91, 61, 127),
      ...ev(0, 0x81, 61, 1),
      ...ev(0, 0x92, 62, 90),
      ...ev(0, 0x82, 62, 0),
      ...ev(0, 0xa0, 60, 55),          // noteAftertouch
      ...ev(0, 0xb0, 7, 100),          // controller
      ...ev(0, 0xc0, 42),              // programChange
      ...ev(0, 0xd0, 77),              // channelAftertouch
      ...ev(0, 0xe0, 0x00, 0x40),      // pitchBend 0
      ...ev(0, 0xe1, 0x00, 0x60),      // pitchBend +4096
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const p = parseSmf(bytes)
    const types = p.tracks[0]!.map(e => e.type)
    expect(types).toEqual([
      'noteOn', 'noteOff', 'noteOn', 'noteOff', 'noteOn', 'noteOff',
      'noteAftertouch', 'controller', 'programChange', 'channelAftertouch',
      'pitchBend', 'pitchBend', 'endOfTrack',
    ])
    expect(p.tracks[0]![11]).toMatchObject({ channel: 1, data: { value: 4096 } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('noteOn velocity=0 归一化为 noteOff（byte9 标记，round-trip 还原 0x90）', () => {
    const bytes = smf([[
      ...ev(0, 0x95, 60, 0),           // 0x90 vel0
      ...ev(0, 0x85, 60, 40),          // 真 noteOff
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ type: 'noteOff', data: { key: 60, velocity: 0, byte9: 1 } })
    // 序列化后 0x95 形式还原：第二个字节应为 0x95
    const out = serializeSmf(parseSmf(bytes))
    const idx = out.indexOf(0x95)
    expect(idx).toBeGreaterThan(0)
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })
})

describe('SMF 解析：running status', () => {
  it('同状态连续事件省略状态字节', () => {
    const bytes = smf([[
      ...ev(0, 0x90, 60, 100),
      ...ev(10, 62, 101),              // running：再一个 noteOn
      ...ev(10, 64, 102),              // running：第三个
      ...ev(0, 0x80, 60, 0),
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events.map(e => e.type)).toEqual(['noteOn', 'noteOn', 'noteOn', 'noteOff', 'endOfTrack'])
    expect(events[1]).toMatchObject({ data: { key: 62, velocity: 101 } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('running status 跨 meta/sysex 保持（与 oracle 同口径）', () => {
    const bytes = smf([[
      ...ev(0, 0x91, 60, 100),
      ...ev(10, 0xff, 0x01, 2, 0x61, 0x62),  // meta text "ab"
      ...ev(10, 0xf0, 3, 0x7e, 0x7f, 0xf7),  // sysex（含结尾 F7）
      ...ev(10, 62, 101),                    // running：仍是 0x91 noteOn
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[3]).toMatchObject({ type: 'noteOn', data: { key: 62, velocity: 101 } })
    expect(events[2]).toMatchObject({ type: 'sysEx', data: { bytes: '7e7ff7' } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('轨首出现数据字节（running status 越轨）→ 抛错', () => {
    const bytes = smf([[...ev(0, 60, 100), ...ev(0, 0xff, 0x2f, 0)]])
    expect(() => parseSmf(bytes)).toThrow(/running status/)
  })
})

describe('SMF 解析：meta 事件', () => {
  it('tempo / 拍号 / 调号 / 轨名 / 文本全套', () => {
    const bytes = smf([[
      ...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20),   // tempo 500000
      ...ev(480, 0xff, 0x51, 3, 0x05, 0xb8, 0xd0), // tempo 375000 (160bpm)
      ...ev(0, 0xff, 0x58, 4, 3, 2, 24, 8),        // 3/4
      ...ev(0, 0xff, 0x59, 2, 0xfd, 0x01),         // 调号 -3 小调
      ...ev(0, 0xff, 0x03, 4, 0x74, 0x65, 0x73, 0x74), // trackName "test"
      ...ev(0, 0xff, 0x01, 2, 0x61, 0x62),         // text
      ...ev(0, 0xff, 0x06, 4, 0x63, 0x6f, 0x72, 0x65), // marker
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ type: 'setTempo', data: { microsecondsPerBeat: 500000 } })
    expect(events[2]).toMatchObject({ type: 'timeSignature', data: { numerator: 3, denominator: 4, metronome: 24, thirtyseconds: 8 } })
    expect(events[3]).toMatchObject({ type: 'keySignature', data: { key: -3, scale: 1 } })
    expect(events[4]).toMatchObject({ type: 'trackName', data: { text: 'test' } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('拍号长度 2 也接受（metronome/thirtyseconds 取默认 24/8）', () => {
    const bytes = smf([[...ev(0, 0xff, 0x58, 2, 6, 3), ...ev(0, 0xff, 0x2f, 0)]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ data: { numerator: 6, denominator: 8, metronome: 0x24, thirtyseconds: 0x08 } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('未知 meta 与 sequencerSpecific 原始字节保留', () => {
    const bytes = smf([[
      ...ev(0, 0xff, 0x7a, 3, 0x01, 0x02, 0x03),  // 未知 meta 0x7A
      ...ev(10, 0xff, 0x7f, 4, 0xde, 0xad, 0xbe, 0xef),
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ type: 'unknownMeta', data: { metatypeByte: 0x7a, bytes: '010203' } })
    expect(events[1]).toMatchObject({ type: 'sequencerSpecific', data: { bytes: 'deadbeef' } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('sequenceNumber/channelPrefix/portPrefix/smpteOffset', () => {
    const bytes = smf([[
      ...ev(0, 0xff, 0x00, 2, 0x00, 0x02),
      ...ev(0, 0xff, 0x20, 1, 0x05),
      ...ev(0, 0xff, 0x21, 1, 0x01),
      ...ev(0, 0xff, 0x54, 5, 0x20, 10, 30, 15, 3),  // 25fps
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ data: { number: 2 } })
    expect(events[1]).toMatchObject({ type: 'channelPrefix', data: { channel: 5 } })
    expect(events[2]).toMatchObject({ type: 'portPrefix', data: { port: 1 } })
    expect(events[3]).toMatchObject({ type: 'smpteOffset', data: { frameRate: 25, hour: 0, min: 10, sec: 30, frame: 15, subFrame: 3 } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })
})

describe('SMF 解析：sysex 与多轨', () => {
  it('F0 sysex（含结尾 F7）与 F7 escape 分段', () => {
    const bytes = smf([[
      ...ev(0, 0xf0, 5, 0x7e, 0x7f, 0x09, 0x01, 0xf7),
      ...ev(10, 0xf7, 3, 0x01, 0x02, 0x03),   // escape/续段
      ...ev(0, 0xff, 0x2f, 0),
    ]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]).toMatchObject({ type: 'sysEx', data: { bytes: '7e7f0901f7' } })
    expect(events[1]).toMatchObject({ type: 'endSysEx', data: { bytes: '010203' } })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('format 1 多轨、format 2 接受', () => {
    const bytes = smf([
      [...ev(0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20), ...ev(0, 0xff, 0x2f, 0)],
      [...ev(0, 0x90, 60, 90), ...ev(480, 0x80, 60, 0), ...ev(0, 0xff, 0x2f, 0)],
      [...ev(0, 0xc2, 0x2a), ...ev(0, 0xff, 0x2f, 0)],
    ], 1)
    const p = parseSmf(bytes)
    expect(p.format).toBe(1)
    expect(p.tracks).toHaveLength(3)
    expect(diffAgainstOracle(bytes)).toEqual([])

    const bytes2 = smf([[...ev(0, 0x90, 60, 90), ...ev(0, 0xff, 0x2f, 0)]], 2)
    expect(parseSmf(bytes2).format).toBe(2)
    expect(diffAgainstOracle(bytes2)).toEqual([])
    expectRoundTripIdempotent(bytes)
    expectRoundTripIdempotent(bytes2)
  })

  it('SMPTE 分割格式：smpte 字段 + ticksPerQuarter=0 + round-trip', () => {
    const bytes = smf([[...ev(0, 0x90, 60, 90), ...ev(0, 0xff, 0x2f, 0)]], 0, 0xe728) // 25fps, 40 ticks/frame
    const p = parseSmf(bytes)
    expect(p.ticksPerQuarter).toBe(0)
    expect(p.smpte).toEqual({ fps: 25, ticksPerFrame: 40 })
    expect(diffAgainstOracle(bytes)).toEqual([])
    expectRoundTripIdempotent(bytes)
  })

  it('变长数边界：0x0FFFFFFF 合法、5 字节抛错', () => {
    const big = 0x0fffffff
    const bytes = smf([[...ev(big, 0xff, 0x2f, 0)]])
    const events = parseSmf(bytes).tracks[0]!
    expect(events[0]!.tick).toBe(big)
    expectRoundTripIdempotent(bytes)

    const bad = [...mthd(0, 1, 480), ...mtrk([0x89, 0x80, 0x80, 0x80, 0x80, 0x00, 0xff, 0x2f, 0])]
    expect(() => parseSmf(Uint8Array.from(bad))).toThrow(/变长数/)
  })
})

describe('SMF 坏文件：全部抛错', () => {
  const expectThrow = (bytes: number[] | Uint8Array, pattern?: RegExp) => {
    expect(() => parseSmf(bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes))).toThrow(pattern)
  }

  it('非 MThd 开头', () => {
    expectThrow([...chunk('XXXX', [0, 0, 0, 6])])
    expectThrow([0x4d, 0x54, 0x68])   // 不足 4 字节
  })

  it('MThd 长度 < 6 / 格式非法 / PPQ=0', () => {
    expectThrow([...chunk('MThd', [0, 0, 0, 1, 0, 5])])
    expectThrow([...mthd(3, 1, 480), ...mtrk([...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 0), ...mtrk([...ev(0, 0xff, 0x2f, 0)])])
  })

  it('期望 MTrk 处是别的 chunk', () => {
    expectThrow([...mthd(0, 1, 480), ...chunk('JUNK', [...ev(0, 0xff, 0x2f, 0)])])
  })

  it('MTrk 声明长度超出实际（截断）', () => {
    expectThrow([...mthd(0, 1, 480), 0x4d, 0x54, 0x72, 0x6b, 0x00, 0x00, 0x10, 0x00, 0x00])
  })

  it('轨道数据截断（事件不完整）', () => {
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0x90, 60)])])           // noteOn 少 velocity
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0x90, 60, 100), 0x00, 0x80])]) // noteOff 截断
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x51, 3, 0x07)])]) // meta 截断
    expectThrow([...mthd(0, 1, 480), ...mtrk([0x80])])                          // delta 后立刻 EOF
  })

  it('头块声明轨数多于实际（截断）', () => {
    expectThrow([...mthd(1, 3, 480), ...mtrk([...ev(0, 0xff, 0x2f, 0)])])
  })

  it('meta 长度越界不越界读（抛错）', () => {
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x03, 200, 0x61), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xf0, 99, 0x7e, 0xf7), ...ev(0, 0xff, 0x2f, 0)])])
  })

  it('meta 已知类型长度不符抛错', () => {
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x51, 2, 0x07, 0xa1), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x2f, 2, 0x00, 0x00), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x59, 1, 0x00), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xff, 0x00, 3, 0, 0, 0), ...ev(0, 0xff, 0x2f, 0)])])
  })

  it('SMF 中不允许的系统消息状态字节抛错', () => {
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xf8), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xf1, 0x00), ...ev(0, 0xff, 0x2f, 0)])])
    expectThrow([...mthd(0, 1, 480), ...mtrk([...ev(0, 0xfe), ...ev(0, 0xff, 0x2f, 0)])])
  })

  it('track 前缀之外的垃圾在轨数用尽后被忽略（与 oracle 一致）', () => {
    const bytes = [
      ...mthd(0, 1, 480),
      ...mtrk([...ev(0, 0x90, 60, 90), ...ev(0, 0xff, 0x2f, 0)]),
      0x00, 0x01, 0x02, 0x03,   // 残余垃圾
    ]
    const p = parseSmf(Uint8Array.from(bytes))
    expect(p.tracks).toHaveLength(1)
    expect(diffAgainstOracle(Uint8Array.from(bytes))).toEqual([])
  })
})

describe('SMF 序列化：规范化与校验', () => {
  it('running status 重新应用（字节数压缩），meta 后重置', () => {
    // 原始文件全部带显式状态字节
    const explicit = Uint8Array.from(smf([[
      ...ev(0, 0x90, 60, 100),
      ...ev(10, 0x90, 60, 101),
      ...ev(10, 0x90, 62, 102),
      ...ev(0, 0xff, 0x2f, 0),
    ]]))
    const out = serializeSmf(parseSmf(explicit))
    // 规范化后：后两次 noteOn 走 running status，应少 2 字节
    expect(out.length).toBe(explicit.length - 2)
    // meta 之后重置：再序列化结果幂等
    expect(serializeSmf(parseSmf(out))).toEqual(out)
  })

  it('手造事件缺字段/越界抛错', () => {
    const bad1: ParsedSmf = {
      format: 0, ticksPerQuarter: 480,
      tracks: [[{ tick: 0, type: 'noteOn', channel: 0, data: { key: 60 } }]],  // 缺 velocity
    }
    expect(() => serializeSmf(bad1)).toThrow(/velocity/)
    const bad2: ParsedSmf = {
      format: 0, ticksPerQuarter: 480,
      tracks: [[{ tick: 0, type: 'pitchBend', channel: 0, data: { value: 99999 } }]],
    }
    expect(() => serializeSmf(bad2)).toThrow(/越界/)
    const bad3: ParsedSmf = {
      format: 0, ticksPerQuarter: 480,
      tracks: [[{ tick: 0, type: 'noteOn', channel: 16, data: { key: 60, velocity: 1 } }]],
    }
    expect(() => serializeSmf(bad3)).toThrow(/channel/)
    const bad4: ParsedSmf = {
      format: 0, ticksPerQuarter: 480,
      tracks: [[{ tick: 0, type: 'timeSignature', data: { numerator: 4, denominator: 5, metronome: 24, thirtyseconds: 8 } }]],
    }
    expect(() => serializeSmf(bad4)).toThrow(/2 的幂/)
    const bad5: ParsedSmf = { format: 0, ticksPerQuarter: 100000, tracks: [] }
    expect(() => serializeSmf(bad5)).toThrow(/ticksPerQuarter/)
  })

  it('tick 倒退的乱序事件：稳定排序兜底后可序列化', () => {
    const p: ParsedSmf = {
      format: 0, ticksPerQuarter: 480,
      tracks: [[
        { tick: 96, type: 'noteOn', channel: 0, data: { key: 62, velocity: 1 } },
        { tick: 0, type: 'noteOn', channel: 0, data: { key: 60, velocity: 1 } },
      ]],
    }
    const out = serializeSmf(p)
    const reparsed = parseSmf(out)
    expect(reparsed.tracks[0]!.map(e => e.tick)).toEqual([0, 96])
  })
})

describe('MThd 多余字节与非常规头部（与 oracle 同容错）', () => {
  it('MThd 长度 > 6 时多余字节忽略', () => {
    const bytes = Uint8Array.from([
      ...chunk('MThd', [0, 1, 0, 1, 0x01, 0xf4, 0xaa, 0xbb]),  // 声明长度 8，含 2 字节多余
      ...mtrk([...ev(0, 0x90, 60, 90), ...ev(0, 0xff, 0x2f, 0)]),
    ])
    const p = parseSmf(bytes)
    expect(p.ticksPerQuarter).toBe(500)
    expect(diffAgainstOracle(bytes)).toEqual([])
  })
})
