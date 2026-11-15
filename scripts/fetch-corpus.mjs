// 语料抓取脚本（仅测试期使用）：从 GitHub raw 下载真实 .mid 文件到 tests/fixtures/。
// 逐个用本项目的 parseSmf 与 oracle（midi-file）双解析验证，任一抛错则记录后丢弃。
// 运行：node scripts/fetch-corpus.mjs
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { parseMidi } = require('midi-file')

const REPOS = {
  'Tonejs-Midi': 'Tonejs/Midi',
  'music21': 'cuthbertLab/music21',
  'genre-corpus': 'cjnolet/midi_genre_corpus',
}

const list = readFileSync(new URL('../.tmp/corpus-list.tsv', import.meta.url), 'utf8')
  .trim().split('\n').map(l => l.split('\t'))

mkdirSync(new URL('../tests/fixtures', import.meta.url), { recursive: true })

const results = []
for (const [repoKey, path] of list) {
  const url = `https://raw.githubusercontent.com/${REPOS[repoKey]}/HEAD/${path}`
  const slug = path.replace(/[^\w.-]+/g, '_')
  const dest = new URL(`../tests/fixtures/${slug}`, import.meta.url)
  if (existsSync(dest)) { results.push([slug, 'skip-existing']); continue }
  try {
    const res = await fetch(url)
    if (!res.ok) { results.push([slug, `http-${res.status}`]); continue }
    const bytes = new Uint8Array(await res.arrayBuffer())
    // 抓取期用 oracle 预验证（本项目解析器的验证在差分测试里做）
    parseMidi(bytes)
    results.push([slug, 'ok'])
    writeFileSync(dest, bytes)
  } catch (e) {
    results.push([slug, `parse-fail: ${String(e.message).slice(0, 60)}`])
  }
}

const ok = results.filter(r => r[1] === 'ok' || r[1] === 'skip-existing').length
console.log(`下载完成：${ok}/${list.length} 可用`)
for (const [slug, status] of results) if (status !== 'ok' && status !== 'skip-existing') console.log('  ✗', slug, status)
