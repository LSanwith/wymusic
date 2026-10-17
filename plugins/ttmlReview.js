// TTML 审核：纯脚本，不调用任何 AI
//
// 为什么不整份丢给 AI：一首歌的 TTML 动辄几千字，既贵又慢；而「歌词对不对得上」
// 本来就是可判定的事。现在拿网易云自己的官方歌词当基准做比对，比让模型
// 「感觉一下」更严、更稳，且 0 token。
//
// 规则（都是硬的，任一不过就拒）：
//   1. 体积 ≤ 2MB，必须有 <tt> 根节点且闭合
//   2. 每行 <p> 都必须同时有 begin 和 end，且 end > begin
//   3. 时间轴严格递增
//   4. 行数 ≥ 8、≤ 4000；不能有空行
//   5. 歌词跨度必须覆盖歌曲时长的 50%~115%（不完整直接拒）
//   6. 行内文本重复率不能过高（同一句刷满全部行）
//   7. 与官方歌词的 4-gram 重合率 ≥ 70%，且对【每个】id 都要成立
//   8. 该曲必须有官方歌词（纯音乐、无歌词一律拒）
//
// 关于体积上限：实测中文歌逐行约 4KB、逐字 span 约 32KB、逐字+双语约 64KB，
// 但超长歌曲 / 每个 span 都带 ttm:agent 等属性 / 多语言 div 叠加时会明显变大，
// 所以放宽到 2MB。Vercel 函数请求体上限是 4.5MB，2MB 留足了余量；
// 而且体积几乎全在标记上，剥出来参与比对的正文只有几 KB，不影响比对性能。
//
// 关于 TTML 语义（参考 https://amll.dev/guides/lyric/ttml 与 Apple Music 的
// syllable-lyrics 结构）：比对正文时必须排除「非歌词」的内容，否则会稀释重合率、
// 把好文件误拒：
//   - <span ttm:role="x-translation">  翻译
//   - <span ttm:role="x-roman">        音译/罗马音
//   - <span tts:ruby="text">           注音（如振假名），base 才是正文
//   - <iTunesMetadata><translations>   行外翻译，本来就在 <head> 里，天然排除
//   - <span ttm:role="x-bg">           背景人声，属于歌词，保留
// 时间也按规范支持三种写法：MM:SS.fff / HH:MM:SS.fff / 12.3s，并支持 dur。
const MAX_TTML_BYTES = 2 * 1024 * 1024
const MIN_LINES = 8
const MAX_LINES = 4000
const MIN_NGRAM_RATIO = 0.7
const DURATION_MIN_RATIO = 0.5
const DURATION_MAX_RATIO = 1.15
const MIN_UNIQUE_RATIO = 0.3
const MAX_IDS = 8
const NGRAM = 4

/** 取属性值，单双引号都认 */
function attr(attrs, name) {
  const re = new RegExp(
    '(?:^|\\s)' + name + '\\s*=\\s*["\']([^"\']*)["\']',
    'i',
  )
  const m = String(attrs || '').match(re)
  return m ? m[1] : null
}

/** 把 TTML 里的时间写成秒。支持 MM:SS.fff、HH:MM:SS.fff、12.3s、纯秒数 */
function toSec(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  // 规范里的秒值写法：12.3s
  const sm = s.match(/^(\d+(?:\.\d+)?)s$/i)
  if (sm) return Number(sm[1])
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

// 非歌词内容：翻译、音译
const NON_LYRIC_ROLE = /ttm:role\s*=\s*["']x-(?:translation|roman)["']/i
// 非歌词内容：Ruby 注音（textContainer 包着 text，一起清掉；只留 base）
const RUBY_TEXT = /tts:ruby\s*=\s*["']text(?:Container)?["']/i

/**
 * 把「从接口或网页里复制出来的」TTML 还原成真正的 XML。
 *
 * 两种很常见的污染：
 *   1. JSON 转义：xmlns=\"...\"、整份挤成一行
 *      —— 直接从接口返回的 JSON 里复制 ttml / ttmlLocalizations 字段值就是这样，
 *         Apple Music 的接口返回的正是这种形态
 *   2. HTML 实体：&lt;tt ...&gt;
 *      —— 从网页的代码块里复制
 *
 * 不做还原的话，解析器会报 AttValue: " or ' expected（因为属性引号前面多了反斜杠）。
 */
function normalizeTtmlInput(raw) {
  let s = String(raw == null ? '' : raw).trim()
  if (!s) return s

  // 1) 整段就是一个 JSON 字符串字面量
  if (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      const v = JSON.parse(s)
      if (typeof v === 'string') s = v.trim()
    } catch {
      // 不是合法 JSON 字符串，继续走下面的手工还原
    }
  }

  // 2) 残留的 JSON 转义
  if (/\\[nrt"\/\\]/.test(s)) {
    s = s
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\\//g, '/')
      .replace(/\\\\/g, '\\')
  }

  // 3) HTML 实体（&amp; 放最后，避免把上面解出来的实体再解一次）
  if (/&(?:lt|gt|quot|amp|#34|#39);/.test(s)) {
    s = s
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  }

  // 4) 前面还挂着别的包装就直接截出来。
  //    常见的是把 JSON 里的一整行原样粘进来：
  //      "ttmlLocalizations": "<tt xmlns=...>...</tt>"
  //    反斜杠解开之后这行就变成合法的 XML，但前后的 "键名": " 还在，
  //    直接喂给解析器仍然会失败，所以按 <tt ...</tt> 截一段。
  const start = s.search(/<tt[\s>]/i)
  if (start > 0) {
    const end = s.lastIndexOf('</tt>')
    if (end > start) s = s.slice(start, end + 5).trim()
  }

  return s
}

/** 从一行的内部片段里取出「真正的歌词文本」，按 TTML 语义排除翻译/音译/注音 */
function lyricTextOf(inner) {
  let s = String(inner || '')
  // 先清 ruby 注音容器（它包着 text）
  s = s.replace(
    /<span\b[^>]*tts:ruby\s*=\s*["']text(?:Container)?["'][^>]*>[\s\S]*?<\/span>/gi,
    '',
  )
  // 再清翻译 / 音译（x-bg 里可能嵌着翻译，先清里面这层，x-bg 的正文会留下）
  s = s.replace(
    /<span\b[^>]*ttm:role\s*=\s*["']x-(?:translation|roman)["'][^>]*>[\s\S]*?<\/span>/gi,
    '',
  )
  return textOf(s)
}

/** 取一行的翻译（只用于展示，不参与比对） */
function translationsOf(inner) {
  const out = []
  const re =
    /<span\b([^>]*ttm:role\s*=\s*["']x-translation["'][^>]*)>([\s\S]*?)<\/span>/gi
  let m
  while ((m = re.exec(String(inner || '')))) {
    const t = textOf(m[2])
    if (t) out.push(t)
  }
  return out
}

/** 解析成摘要 + 问题列表 */
function parse(ttml) {
  const src = normalizeTtmlInput(ttml)
  const problems = []

  if (!src.trim()) return { problems: ['TTML 是空的'], digest: null }
  if (Buffer.byteLength(src, 'utf8') > MAX_TTML_BYTES) {
    return { problems: ['TTML 太大（超过 2MB）'], digest: null }
  }

  const hasTt = /<tt[\s>]/i.test(src)
  const hasClose = /<\/tt>/i.test(src)
  if (!hasTt) problems.push('缺少 <tt> 根节点，看起来不是 TTML')
  if (hasTt && !hasClose) problems.push('<tt> 没有闭合')
  if (hasTt && !/<body[\s>]/i.test(src)) problems.push('缺少 <body> 正文区')

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
  let skippedNonLyric = 0

  for (const b of blocks) {
    const attrs = b[1] || ''

    // 整行就是翻译/音译（有些 TTML 这么写），不算歌词行
    if (NON_LYRIC_ROLE.test(attrs)) {
      skippedNonLyric++
      continue
    }

    const text = lyricTextOf(b[2])
    const beginRaw = attr(attrs, 'begin')
    const endRaw = attr(attrs, 'end')
    const durRaw = attr(attrs, 'dur')

    const begin = toSec(beginRaw)
    let end = toSec(endRaw)
    // 规范允许只给 begin + dur
    if (end == null && begin != null) {
      const dur = toSec(durRaw)
      if (dur != null) end = begin + dur
    }

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
    skippedNonLyric,
    emptyLines,
    missingTiming,
    badRange,
    monotonic,
    chars: lines.reduce((n, s) => n + s.length, 0),
    durationSec,
    uniqueRatio: lines.length ? textSet.size / lines.length : 0,
    head: lines.slice(0, 6),
    tail: lines.length > 6 ? lines.slice(-3) : [],
    // 全文拼在一起，供与官方歌词比对（已排除翻译/音译/注音）
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
      out.push(`有 ${d.missingTiming} 行缺少 begin/end（或 begin + dur）`)
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
 */
function contentRatio(ttmlText, officialText) {
  const a = normalize(ttmlText)
  const b = normalize(officialText)
  if (!a || !b) {
    return { ratio: 0, threshold: MIN_NGRAM_RATIO, ok: false, hit: 0, total: 0 }
  }
  const bg = grams(b, NGRAM)
  const ag = grams(a, NGRAM)
  if (!ag.size) {
    return { ratio: 0, threshold: MIN_NGRAM_RATIO, ok: false, hit: 0, total: 0 }
  }
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
  lyricTextOf,
  translationsOf,
  normalizeTtmlInput,
  lrcTextOf,
  lyricUsable,
  normalize,
  toSec,
}
