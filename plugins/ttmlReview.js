// TTML 审核：纯脚本，不调用任何 AI
//
// 为什么不用 AI：一首歌的 TTML 动辄几千字，整份塞给模型既贵又慢；
// 而且「歌词对不对得上」本来就是可判定的事，不需要判断力。
// 现在拿网易云自己的官方歌词当基准做比对，比让模型「感觉一下」更严、更稳，
// 且 0 token。
//
// 规则（都是硬的，任一不过就拒）：
//   1. 体积 ≤ 256KB，必须有 <tt> 根节点且闭合
//   2. 每行 <p> 都必须同时有 begin 和 end，且 end > begin
//   3. 时间轴严格递增
//   4. 行数 ≥ 8、≤ 4000；不能有空行
//   5. 歌词跨度必须覆盖歌曲时长的 50%~115%（不完整直接拒）
//   6. 行内文本重复率不能过高（同一句刷满全部行）
//   7. 与官方歌词的 4-gram 重合率 ≥ 70%，且对【每个】id 都要成立
//   8. 该曲必须有官方歌词（纯音乐、无歌词一律拒）
const MAX_TTML_BYTES = 256 * 1024
const MIN_LINES = 8
const MAX_LINES = 4000
const MIN_NGRAM_RATIO = 0.7
const DURATION_MIN_RATIO = 0.5
const DURATION_MAX_RATIO = 1.15
const MIN_UNIQUE_RATIO = 0.3
const MAX_IDS = 8
const NGRAM = 4

/** 把 TTML 里的时间写成秒。支持 mm:ss.mmm、hh:mm:ss.mmm、纯秒数 */
function toSec(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const m = s.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?$/)
  if (!m) return null
  const h = m[1] ? Number(m[1]) : 0
  const min = Number(m[2])
  const sec = Number(m[3])
  const frac = m[4] ? Number('0.' + m[4]) : 0
  return h * 3600 + min * 60 + sec + frac
}

/** 去掉标签，只留文本 */
function textOf(fragment) {
  return String(fragment || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim()
}

/** 解析成摘要 + 问题列表 */
function parse(ttml) {
  const src = String(ttml || '')
  const problems = []

  if (!src.trim()) return { problems: ['TTML 是空的'], digest: null }
  if (Buffer.byteLength(src, 'utf8') > MAX_TTML_BYTES) {
    return { problems: ['TTML 太大（超过 256KB）'], digest: null }
  }

  const hasTt = /<tt[\s>]/i.test(src)
  const hasClose = /<\/tt>/i.test(src)
  if (!hasTt) problems.push('缺少 <tt> 根节点，看起来不是 TTML')
  if (hasTt && !hasClose) problems.push('<tt> 没有闭合')

  const blocks = [...src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
  const lines = []
  const textSet = new Set()
  let beginFirst = null
  let endLast = null
  let monotonic = true
  let prevBegin = -Infinity
  let emptyLines = 0
  let missingTiming = 0
  let badRange = 0

  for (const b of blocks) {
    const attrs = b[1] || ''
    const text = textOf(b[2])
    const bm = attrs.match(/\bbegin\s*=\s*"([^"]*)"/i)
    const em = attrs.match(/\bend\s*=\s*"([^"]*)"/i)
    const begin = bm ? toSec(bm[1]) : null
    const end = em ? toSec(em[1]) : null

    if (begin == null || end == null) missingTiming++
    if (begin != null && end != null && end <= begin) badRange++

    if (begin != null) {
      if (begin < prevBegin) monotonic = false
      prevBegin = begin
      if (beginFirst == null) beginFirst = begin
    }
    if (end != null) endLast = end

    if (!text) emptyLines++
    else {
      lines.push(text)
      textSet.add(text)
    }
  }

  const durationSec =
    beginFirst != null && endLast != null && endLast > beginFirst
      ? Math.round(endLast - beginFirst)
      : null

  const digest = {
    lineCount: lines.length,
    blockCount: blocks.length,
    emptyLines,
    missingTiming,
    badRange,
    monotonic,
    chars: lines.reduce((n, s) => n + s.length, 0),
    durationSec,
    uniqueRatio: lines.length ? textSet.size / lines.length : 0,
    head: lines.slice(0, 6),
    tail: lines.length > 6 ? lines.slice(-3) : [],
    // 全文拼在一起，供与官方歌词比对
    text: lines.join('\n'),
  }

  return { problems, digest }
}

/** 结构检查（严） */
function structuralCheck(ttml, songDurSec) {
  const { problems, digest: d } = parse(ttml)
  const out = problems.slice()

  if (d) {
    if (d.blockCount === 0) out.push('没有任何 <p> 歌词行')
    if (d.lineCount < MIN_LINES) {
      out.push(`有效歌词只有 ${d.lineCount} 行，少于 ${MIN_LINES} 行，不完整`)
    }
    if (d.lineCount > MAX_LINES) out.push(`歌词行数 ${d.lineCount} 异常`)
    if (d.emptyLines > 0) out.push(`有 ${d.emptyLines} 行是空的`)
    if (d.missingTiming > 0) {
      out.push(`有 ${d.missingTiming} 行缺少 begin 或 end 时间戳`)
    }
    if (d.badRange > 0) out.push(`有 ${d.badRange} 行的 end 不晚于 begin`)
    if (!d.monotonic) out.push('时间轴不是递增的')
    if (d.uniqueRatio < MIN_UNIQUE_RATIO) {
      out.push('行内文本重复率过高，疑似刷行')
    }

    if (songDurSec) {
      const span = d.durationSec
      if (span == null) {
        out.push('算不出歌词总时长，无法核对完整性')
      } else if (span < songDurSec * DURATION_MIN_RATIO) {
        out.push(
          `歌词只覆盖 ${span}s，不到歌曲时长 ${songDurSec}s 的一半，不完整`,
        )
      } else if (span > songDurSec * DURATION_MAX_RATIO) {
        out.push(`歌词跨度 ${span}s 超过歌曲时长 ${songDurSec}s 太多`)
      }
    }
  }

  return { ok: out.length === 0, problems: out, digest: d }
}

/** 归一化：只留字母与数字（含中文），去掉标点与空白 */
function normalize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/** 取 n-gram 集合 */
function grams(s, n) {
  const set = new Set()
  if (!s) return set
  if (s.length <= n) {
    set.add(s)
    return set
  }
  for (let i = 0; i + n <= s.length; i++) set.add(s.slice(i, i + n))
  return set
}

/**
 * TTML 文本与官方歌词的重合率。
 * 用 4-gram 而不是逐行比对：TTML 可能把一行拆成逐字/逐词（Apple 那种），
 * 逐行对不上，但字面内容的重合度依然准确。
 *
 * 返回 { ratio, threshold, ok, ttmlGrams, hit }
 */
function contentRatio(ttmlText, officialText) {
  const a = normalize(ttmlText)
  const b = normalize(officialText)
  if (!a || !b)
    return { ratio: 0, threshold: MIN_NGRAM_RATIO, ok: false, hit: 0, total: 0 }
  const bg = grams(b, NGRAM)
  const ag = grams(a, NGRAM)
  if (!ag.size)
    return { ratio: 0, threshold: MIN_NGRAM_RATIO, ok: false, hit: 0, total: 0 }
  let hit = 0
  for (const g of ag) if (bg.has(g)) hit++
  const ratio = hit / ag.size
  return {
    ratio: Math.round(ratio * 1000) / 1000,
    threshold: MIN_NGRAM_RATIO,
    ok: ratio >= MIN_NGRAM_RATIO,
    hit,
    total: ag.size,
  }
}

/** 从 LRC 原文里剥掉 [mm:ss.xx] 这类时间标签，只留可读歌词 */
function lrcTextOf(lrc) {
  return String(lrc || '')
    .split('\n')
    .map((l) => l.replace(/\[[^\]]*\]/g, '').trim())
    .filter(Boolean)
    .join('\n')
}

/** 官方歌词是否可用（有的歌是纯音乐，lrc 为空或只有一句提示） */
function lyricUsable(lrc) {
  const t = lrcTextOf(lrc)
  if (!t) return false
  if (/纯音乐|请欣赏|暂无歌词|没有歌词|no lyrics/i.test(t)) return false
  return normalize(t).length >= 20
}

module.exports = {
  MAX_TTML_BYTES,
  MIN_LINES,
  MIN_NGRAM_RATIO,
  MAX_IDS,
  parse,
  structuralCheck,
  contentRatio,
  lrcTextOf,
  lyricUsable,
  normalize,
}
