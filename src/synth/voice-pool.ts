// 复音管理（纯逻辑，Node 可测）：voices 上限 32、同 key 重触发、偷音取最旧。
// 与 Web Audio 解耦：调用方（Synth）拿到分配结果后自行驱动节点。

export interface VoiceRecord {
  id: number
  channel: number
  key: number
  /** AudioContext 起音时刻 */
  startedAt: number
  /** 是否已进入 release（仍占用 voice 槽直到终止时刻） */
  released: boolean
  /** 语音终止（可复用槽位）时刻 */
  endsAt: number
}

export interface AllocateResult {
  voice: VoiceRecord
  /** 因上限被偷的最旧语音（调用方做快速淡出后移除） */
  stolen?: VoiceRecord
}

const MAX_VOICES = 32

/** 复音池：活跃语音 ≤ MAX_VOICES；超限偷"最旧"（startedAt 最小） */
export class VoicePool {
  private nextId = 1
  private readonly active: VoiceRecord[] = []

  /** 分配一个新 voice；同 (channel,key) 仍有未释放语音时返回 retrigger（调用方自行淡出旧音） */
  allocate(channel: number, key: number, startedAt: number, endsAt: number): AllocateResult {
    const result: AllocateResult = {
      voice: { id: this.nextId++, channel, key, startedAt, released: false, endsAt },
    }

    let oldest: VoiceRecord | undefined
    for (const v of this.active) {
      if (!oldest || v.startedAt < oldest.startedAt) oldest = v
    }
    // 同 key 重触发信息（不是偷音，仅提示）
    for (const v of this.active) {
      if (v.channel === channel && v.key === key && !v.released) {
        result.stolen = v // 复用字段：调用方按"重触发"处理旧语音
        break
      }
    }

    if (this.active.length >= MAX_VOICES) {
      // 上限：偷最旧，回收槽位后放入新语音
      const victim = oldest!
      this.remove(victim.id)
      result.stolen = victim
      this.active.push(result.voice)
      return result
    }

    this.active.push(result.voice)
    return result
  }

  /** 标记释放（sustain 段开始），返回该语音（不存在返回 undefined） */
  release(id: number): VoiceRecord | undefined {
    const v = this.active.find(x => x.id === id)
    if (v) v.released = true
    return v
  }

  /** 移除语音（终止后回收槽位） */
  remove(id: number): void {
    const i = this.active.findIndex(x => x.id === id)
    if (i >= 0) this.active.splice(i, 1)
  }

  /** 现在时刻 shouldEnd 的语音回收（endOfTrack/清理用） */
  sweep(now: number): VoiceRecord[] {
    const dead = this.active.filter(v => v.released && v.endsAt <= now)
    for (const v of dead) this.remove(v.id)
    return dead
  }

  /** 活跃语音（含释放中未终止的） */
  list(): readonly VoiceRecord[] {
    return this.active
  }

  get size(): number {
    return this.active.length
  }
}
