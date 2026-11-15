// 单文件 Web 构建：esbuild 打包 src/web/main.ts → 内联进 dist/index.html。
// 内置 2 首测试曲以 base64 嵌入；AudioWorklet 源码作为字符串模块随 bundle 内联（Blob URL 加载）。
import { build } from 'esbuild'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('..', import.meta.url)

// 1. 打包主脚本
const result = await build({
  entryPoints: [fileURLToPath(new URL('../src/web/main.ts', import.meta.url))],
  bundle: true,
  minify: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  charset: 'utf8',
})
const js = result.outputFiles[0].text

// 2. 内置测试曲（两首，base64）
const SONGS = [
  {
    name: '巴赫 · 平均律键盘曲集 BWV846 前奏曲（Bernd Krueger 序列）',
    file: 'test_midi_bach_bach_846.mid',
  },
  {
    name: '斯科特·乔普林 · The Entertainer',
    file: 'test_midi_joplin_TheEntertainer.mid',
  },
]
const songsB64 = SONGS.map(s => ({
  name: s.name,
  data: readFileSync(fileURLToPath(new URL(`../tests/fixtures/${s.file}`, import.meta.url))).toString('base64'),
}))

// 3. 组装单文件 HTML
const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>midi-lab · MIDI 播放器 + 软件合成器</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.6 system-ui, sans-serif; background: #0e1116; color: #d8dee6; }
  main { max-width: 960px; margin: 0 auto; padding: 24px 16px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8b95a3; margin-bottom: 20px; }
  .drop { border: 2px dashed #3a4353; border-radius: 12px; padding: 28px; text-align: center; color: #8b95a3; margin-bottom: 16px; transition: all .15s; }
  .drop.hot { border-color: #5ea0f2; color: #5ea0f2; background: rgba(94,160,242,.06); }
  canvas { display: block; width: 100%; background: #141922; border: 1px solid #232b38; border-radius: 8px; }
  .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
  button { background: #1c2431; color: #d8dee6; border: 1px solid #2e3948; border-radius: 8px; padding: 7px 14px; cursor: pointer; font: inherit; }
  button:hover { background: #253044; }
  button.primary { background: #2b5d9e; border-color: #3c74b8; }
  button:disabled { opacity: .45; cursor: not-allowed; }
  input[type=range] { accent-color: #5ea0f2; }
  label { color: #9aa5b1; }
  .bar { height: 8px; background: #1c2431; border-radius: 4px; overflow: hidden; flex: 1; }
  .bar > i { display: block; height: 100%; width: 0%; background: #5ea0f2; }
  .panel { display: flex; gap: 20px; flex-wrap: wrap; margin-top: 8px; }
  .panel > div { min-width: 200px; }
  .info { color: #8b95a3; font-size: 12px; margin-top: 6px; }
  footer { margin-top: 40px; color: #667080; font-size: 12px; }
  #selftest { margin-top: 24px; }
  pre { background: #141922; border: 1px solid #232b38; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; }
</style>
</head>
<body>
<main>
  <h1>midi-lab</h1>
  <div class="sub">MIDI 1.0 播放器 + 纯手写软件合成器（1983 规格冻结）— 拖入 .mid 文件或点下方按钮</div>
  <div class="drop" id="drop">把 .mid 文件拖到这里</div>
  <div class="row">
    <button class="primary" id="play" disabled>▶ 播放</button>
    <button id="stop" disabled>■ 停止</button>
    <div class="bar"><i id="progress"></i></div>
    <span id="time">0:00 / 0:00</span>
  </div>
  <canvas id="roll" height="260"></canvas>
  <canvas id="wave" height="90"></canvas>
  <div class="row" id="songs"></div>
  <div class="panel">
    <div><label>主音量 <input type="range" id="vol" min="0" max="150" value="90"></label></div>
    <div><label>混响 <input type="range" id="rev" min="0" max="100" value="22"></label></div>
    <div><label>试音音色（GM） <select id="prog"></select></label></div>
    <div><button id="prelude">🎵 试音（C 和弦）</button></div>
  </div>
  <div class="info" id="info">未加载曲目</div>
  <div id="selftest">
    <button id="run-selftest">🧪 运行离线渲染验收（自检）</button>
    <pre id="selftest-out" style="display:none"></pre>
  </div>
  <footer>
    合成器/解析器零依赖手写（SMF 解析、PeriodicWave 系数、RBJ 滤波、Schroeder 混响、lookahead 调度）。<br>
    内置测试曲来自 music21 语料与 piano-midi.de（Bernd Krueger 序列），仅作演示。
  </footer>
</main>
<script>
window.__MIDILAB_SONGS__ = ${JSON.stringify(songsB64)};
</script>
<script>${js}</script>
</body>
</html>
`

mkdirSync(fileURLToPath(new URL('../dist', import.meta.url)), { recursive: true })
writeFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), html)
console.log('dist/index.html 写入完成（' + (html.length / 1024).toFixed(0) + 'KB）')
