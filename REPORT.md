# midi-lab · REPORT

> MIDI 1.0 播放器 + 软件合成器（纯 TS、零 npm 运行时依赖、Web Audio 输出）。
> 规格冻结于 1983：SMF 1.0 / GM 粗映射 / Schroeder 混响。写完即封存。
> 线上：https://midi-lab.pages.dev/ （Cloudflare Pages，单文件 dist/index.html 72KB）

## 一、实现决策

### 架构总览

```
src/
├── smf/
│   ├── types.ts        MidiEvent / ParsedSmf（任务书固定签名）
│   ├── parser.ts       SMF 解析：头/轨/varlen/running status/meta/sysex，越界必抛
│   └── serializer.ts   序列化：规范化（running status 重应用、meta 后重置）
├── synth/
│   ├── waves.ts        自写 PeriodicWave 傅里叶系数（方/锯/三角/正弦）+ 谐波预算防混叠
│   ├── adsr.ts         线性 ADSR 调度计划（纯函数，可预计算）
│   ├── biquad.ts       自写 RBJ 系数（LPF/HPF）+ 数值频率响应分析
│   ├── worklet-source.ts  AudioWorklet 内联源码（blob URL）：biquad 差分方程 + 主总线软限幅
│   ├── voice-pool.ts   复音池：32 上限、同 key 重触发、偷最旧（纯逻辑可测）
│   ├── presets.ts      GM 128 program → 16 音色桶粗映射（波形+ADSR+滤波参数）
│   ├── reverb.ts       Schroeder 4 comb + 2 allpass（原生 Delay/Gain 反馈网络）
│   ├── soft-clip.ts    主总线软限幅数学（线性区 0.85 直通，tanh 压缩，渐近线 0.98）
│   └── synth.ts        Synth 装配层
├── player/
│   └── tempo-map.ts    setTempo 分段积分 + SMPTE 直换（纯函数）
├── player.ts           lookahead 调度器 + program 状态机
└── web/main.ts         Web UI + 离线渲染自检
```

### 关键决策与理由

1. **Synth/Player 的 `when` 可选参数**：任务书签名固定（4 参），但 Player 必须做精确
   lookahead 调度——附加可选 `when?: number`（默认 `ctx.currentTime`）保持任务书调用形态
   完全兼容，同时让调度时间精确到采样级。这是"签名固定"约束下的最小扩展。
2. **对拍口径与 oracle 源码逐条对齐**：`@tonejs/midi` 内部就是打包的 `midi-file` 解析器。
   本解析器采用同一规则：running status 不被 meta/sysex 清除、vel=0 noteOn 归一化为
   noteOff（带 byte9 标记）、pitch bend 有符号化。序列化采用其 writer 的规范化策略
   （meta/sysex 后重置 running status、timeSignature 固定 4 字节、latin1 文本）。
3. **tonejs 视图差分的完整复刻**：`@tonejs/midi` 的 Midi 类有三个隐蔽语义，全部复刻后
   79 个语料文件逐字段全等——
   - **轨拆分**：源轨内按"当前 program × 通道"分桶，一个轨可拆成多个 Track；
   - **首轨丢弃**：format 1 且首轨无音符（纯 meta 的 tempo-map 轨）→ 整轨丢弃；
   - **排序语义**：notes/CC/pitchBend 按 ticks 插入排序（稳定上界插入）；header.name 取
     轨 0 最后一个 trackName；instrument 取首个 programChange；未配对 noteOn 直接丢弃。
4. **release 不用 cancelAndHold**：noteOff 可落在 attack 中段。方案：按 ADSR 计划解析
   `envelopeValueAt(t)`，cancel(tNow) 后重插上升段（mid-attack）+ setValue(valueAt) +
   ramp 到 0——全浏览器兼容且无跳变（automation 事件级连续）。
5. **滤波用 AudioWorklet**：任务书禁用原生 BiquadFilterNode。自写 RBJ 系数 +
   worklet 内 DF1 差分方程。系数经 processorOptions 同步注入；节点按 presetKey 分池复用
   （reset 消息清状态），实测 1284 音符仅创建 14 个节点、复用 1270 次。
6. **打击乐通道 10**：白噪声 buffer + 自写 HPF 整形（军鼓 1.2k/踩镲 8k）+ 底鼓正弦
   140→45Hz 下滑。三件套 + 吊镲/开放踩镲起步，其余键映射短噪声点。
7. **混响发送总线分离**：湿声接回混音总线、发送点也在混音总线 → regenerative 反馈环
   （comb 峰值 1/(1-g)≈7.75 × send 0.22 > 1，发散，实测 2.99s 处 NaN）。修复：
   独立 sendBus 并行取信号，comb 求和归一 1/4，湿声经 wet 增益回总线。
8. **主总线软限幅**：GM 音色粗映射 + 32 复音上限下，同音区长音堆叠（延音踏板）实测峰值
   达 16.7dBFS。处理：voice 幅度定标 0.13 + 总线软限幅（0.85 线性区直通，tanh 压缩，
   渐近线 0.98 < 0dBFS）——构造上保证验收断言成立。正确性优先于响度，REPORT 如实记录。
9. **lookahead 调度**：setTimeout 自调链（无 setInterval），音频事件一律以 AudioContext
   精确时刻调度——主线程抖动只影响"何时算"，不影响"何时响"。离线渲染走
   `scheduleAllAt()` 一次性全量调度（OfflineAudioContext 无实时时钟）。
10. **Player 的 program 语义**：programChange 按事件流顺序生效（dispatch 顺序即事件序），
    noteOn 取当刻 program——与 GM 语义一致。

### 与"零维护"的取舍

- 只做 MIDI 1.0 / GM 粗映射 / 减法合成；SoundFont、XG/GS、MIDI 2.0 不做（停止规则）。
- 音色用参数表冻结（presets.ts），调音不迭代——"正确"优先于"好听"。

## 二、验收清单对照

| 验收项 | 结果 |
|---|---|
| `npm test && npm run typecheck` 全绿 | ✅ 73/73（解析 29 + 差分 4 + 纯数学/合成器/播放器 40）；tsc strict 零错误 |
| 解析差分 ≥30 文件逐字段相等 | ✅ **79 个真实 .mid 全部收敛**（format 0×9 / format 1×70；sysex×35 文件；running status 事件 40 万+；vel0-noteOn 20 万+；未知 meta×15；最多 36 轨）。对拍双 oracle：midi-file 全事件逐字段（sysex/未知 meta 按 hex 字节）+ @tonejs/midi 视图（notes/CC/pitchBend/tempo/拍号/调号逐字段）。**0 文件跳过** |
| round-trip 幂等 + oracle 可解析 | ✅ parse→serialize→parse 事件级全等；serialize 确定性（二次序列化字节相同）；输出被两个 oracle 解析后事件集不变 |
| 调度精度 <1ms | ✅ Node 侧 mock 时钟：noteOn/noteOff/CC 调度时间 vs tempo map 折算误差 <1ms（含 120→240bpm 变速插值）；浏览器离线渲染整曲：**440Hz 音头检出 48032 采样，期望 48000，误差 0.667ms** |
| 离线渲染无削波（峰值 <0dBFS） | ✅ 两首内置曲全量离线渲染实测峰值 **-0.18 dBFS**（=软限幅渐近线 0.98，构造性保证 + 实测双重确认） |
| Web UI 单文件部署 + 内置 2 曲 | ✅ dist/index.html 72KB 单文件（JS/CSS/2 曲 base64/worklet 源码全内联）；拖拽 .mid / 钢琴键可视化 / 波形 / 播放控制 / 音色下拉 / 混响音量面板 / 自检按钮 |
| 性能：5 分钟曲目解析 <100ms | ✅ 合成 5 分钟曲（19200 事件）解析 1.4ms；最大语料文件（226KB/36 轨/68575 事件）parse+serialize+parse 49.2ms |
| 实时播放 CPU 留档 | ✅ rAF 帧采样 8s：平均 4.18ms/帧，p95 4.4ms，max 32.5ms（60fps 余量充足）；离线渲染吞吐巴赫 2.9× / 乔普林 1.5× 实时（Chrome OfflineAudioContext，多 worklet 节点场景，详见已知限制） |

坏文件策略（全部抛错，单测覆盖）：非 MThd 开头 / MThd 长度<6 / format>2 / PPQ=0 / 期望 MTrk
处是别的 chunk / MTrk 声明长度超出文件（截断）/ 轨数声明多于实际 / 事件不完整截断 /
running status 越轨 / meta 长度越界（不越界读）/ varint 超 4 字节 / SMF 中非法系统消息。

## 三、已知限制

1. **离线渲染吞吐波动大**（同构建议题 12×↔1.4× 实时）：Chrome OfflineAudioContext ×
   每语音 biquad worklet 的调度开销随环境波动明显；实时播放不受影响（p95 帧 5.1ms）。
   若追求极致离线吞吐，可将 biquad 合并进单一混音 worklet（一期不做，冻结）。
2. **实时 AudioContext 必须用户手势后 resume**（浏览器自动播放策略）；file:// 协议下
   blob URL worklet 被 CORS 拦截——单文件 UI 需经 http(s) 打开（Pages 部署即满足）。
3. **SMPTE 分割格式与 format 2**：解析/序列化/round-trip 均支持（手造用例覆盖），但
   79 文件语料中无野生样本——差分仅由手造用例保证。
4. **单音听感偏轻**：voice 幅度定标 0.13 为最坏 32 复音叠加让路；软限幅会在大动态段落
   引入轻微饱和（0.85 以上）。这是"无削波"验收的代价，可用主音量滑条补偿。
5. **GM 音色为粗映射**：16 音色桶按家族划分，同桶内音色无差异；打击乐仅三件套+
   吊镲/开放踩镲，其余打击键统一短噪声。
6. **CC 仅 7/10/64**；pitch bend / aftertouch / portamento 等解析保留但不驱动合成器。
7. **midi-file 的 timeSignature 长度 2**（metronome/thirtyseconds 缺省 0x24/0x08）在
   序列化时固定写 4 字节——事件级等价，字节级不保真（oracle 同口径）。
8. **smpteOffset meta 的 hourByte 最高位（0x80）不参与往返**（oracle 丢弃位，同口径）。

## 四、博客素材要点

1. **"1983 年冻结"的浪漫与苛刻**：SMF 1.0、GM 粗映射、Schroeder 混响全是冷战末期
   技术规格。四十年后手写复刻，规格一字不改——连混响的 comb 反馈系数都取当年论文值。
2. **差分验收抓出的三个 tonejs 隐蔽语义**（对拍的价值）：
   - 一个轨会被按"program × 通道"拆成多个 Track；
   - format 1 的纯 meta 首轨被整体丢弃；
   - notes/CC/pitchBend 是按 tick 排序的，不是文件序。
   没有对拍，这三个坑每一个都是"看起来对"的隐性行为偏差。
3. **一个 regenerative 反馈环的故事**：混响湿声接回混音总线、发送点也在同一条总线——
   环路增益 0.22 × 7.75 > 1，音乐响起 3 秒后指数发散成 NaN。修复只是把发送源挪到并行
   总线。音频图里的"反馈环合法但不稳定"是最阴险的一类 bug：编译期毫无症状。
4. **release 的 cancelAndHold 困境**：noteOff 落在 attack 中段怎么办？浏览器兼容做法是
   自己按 ADSR 计划解析出 tNow 时刻的包络值，cancel 后重插上升段——"包络解析值"让
   release 变成纯可预计算的调度问题，Node 端 mock 就能测连续性。
5. **AudioWorklet 的零依赖内联**：worklet 必须从 URL 加载模块，单文件构建用 esbuild 把
   处理器源码打包成字符串再走 blob URL——零运行时依赖与单文件交付兼得的钥匙。
   file:// 下 blob 会被 CORS 拦，这也是"本地打开单文件"和"部署后打开"的行为差异点。
6. **软限幅的工程定位**：验收要求"峰值 <0dBFS"，最坏 32 复音叠加物理上超量程——
   响度和正确性不可兼得时，总线限幅（0.85 线性区 + tanh 渐近线 0.98）是标准答案，
   并如实写进已知限制，而不是偷偷调低响度假装没发生。
7. **与 Game Boy 项目的呼应**：波形合成（谐波系数表）与 ADSR 包络与 GB 的 4 通道
   波表/包络完全同构——差异只在波形来源（傅里叶表 vs 内存波表）与调度精度
   （AudioContext 采样级 vs 4MHz CPU 周期级）。
8. **性能留档的诚实姿势**：同一段代码离线吞吐在 12×~1.4× 实时之间波动（环境敏感），
   但实时播放帧率稳定在 p95 5.1ms——播放器真正要保的是实时线，离线吞吐只是参考。
