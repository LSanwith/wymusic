// TTML 审核
//
// 分两段，目的就是省 token：
//   1. 结构检查（本地做，0 token）：能不能解析、有多少行、时间轴是否递增、
//      有没有空行、时长是否离谱
//   2. 语义检查（花钱，才交 AI）：歌词内容是否真对应这几首歌
//
// 交给 AI 的不是整份 TTML，而是上面算好的摘要：行数、时长、开头几行、结尾几行。
// 一首歌的 TTML 动辄几千字，全发过去一次就上千 token；发摘要通常 300 以内。
const MAX_TTML_BYTES = 256 * 1024
const MAX_AI_IDS = 8
const MIN_LINES = 4 // 少于 4 行基本不可能是完整歌词

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

/**
 * 解析成摘要。不追求完整 TTML 规范，只要够判断「是不是一份像样的歌词」。
 * 返回 { ok, problems, digest }
 */
function parse(ttml) {
  const src = String(ttml || '')
  const problems = []

  if (!src.trim()) return { ok: false, problems: ['TTML 是空的'], digest: null }
  if (Buffer.byteLength(src, 'utf8') > MAX_TTML_BYTES) {
    return { ok: false, problems: ['TTML 太大（超过 256KB）'], digest: null }
  }

  const hasTt = /<tt[\s>]/i.test(src)
  const hasClose = /<\/tt>/i.test(src)
  if (!hasTt) problems.push('缺少 <tt> 根节点，看起来不是 TTML')
  if (hasTt && !hasClose) problems.push('<tt> 没有闭合')

  const blocks = [...src.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)]
  const lines = []
  let beginFirst = null
  let endLast = null
  let monotonic = true
  let prevBegin = -Infinity
  let emptyLines = 0

  for (const b of blocks) {
    const attrs = b[1] || ''
    const text = textOf(b[2])
    const bm = attrs.match(/\bbegin\s*=\s*"([^"]*)"/i)
    const em = attrs.match(/\bend\s*=\s*"([^"]*)"/i)
    const begin = bm ? toSec(bm[1]) : null
    const end = em ? toSec(em[1]) : null
    if (begin != null) {
      if (begin < prevBegin) monotonic = false
      prevBegin = begin
      if (beginFirst == null) beginFirst = begin
    }
    if (end != null) endLast = end
    if (!text) emptyLines++
    else lines.push(text)
  }

  if (!blocks.length) problems.push('没有任何 <p> 歌词行')
  if (lines.length && lines.length < MIN_LINES) {
    problems.push(`歌词只有 ${lines.length} 行，太短，疑似不完整`)
  }
  if (emptyLines > blocks.length * 0.5 && blocks.length > 0) {
    problems.push('超过一半的歌词行没有文字')
  }
  if (!monotonic) problems.push('时间轴不是递增的，可能是拼错的')
  if (beginFirst == null) problems.push('歌词行没有 begin 时间戳')

  const chars = lines.reduce((n, s) => n + s.length, 0)
  const durationSec =
    beginFirst != null && endLast != null && endLast > beginFirst
      ? Math.round(endLast - beginFirst)
      : null

  const digest = {
    lineCount: lines.length,
    blockCount: blocks.length,
    emptyLines,
    chars,
    durationSec,
    monotonic,
    // 只留头尾，给 AI 用，省 token
    head: lines.slice(0, 6),
    tail: lines.length > 6 ? lines.slice(-3) : [],
  }

  return { ok: problems.length === 0, problems, digest }
}

/** 结构检查 + 与歌曲时长对照（网易云详情的 dt 是毫秒） */
function structuralCheck(ttml, songDurationsSec) {
  const parsed = parse(ttml)
  const problems = parsed.problems.slice()
  const d = parsed.digest

  if (d && d.durationSec && songDurationsSec.length) {
    // 歌词跨度与歌长差太多也可疑（TTML 允许只覆盖一段，所以只提示不拦）
    const min = Math.min(...songDurationsSec)
    if (d.durationSec > min + 60) {
      problems.push(
        `歌词时长 ${d.durationSec}s 明显超过歌曲时长 ${min}s，可能是错配`,
      )
    }
  }

  // 时长异常短（<10s）且行数少，视为不完整
  if (d && d.durationSec != null && d.durationSec < 10) {
    problems.push('歌词总时长不到 10 秒，疑似不完整')
  }

  return { ok: problems.length === 0, problems, digest: d }
}

/**
 * 交给 DeepSeek 判断「歌词内容是否对应这几首歌」。
 * 返回 { ok, why, skipped?, tokens? }
 */
async function aiCheck(songs, digest) {
  const key = process.env.DEEPSEEK_API_KEY
  if (!key) {
    return {
      ok: true,
      skipped: true,
      why: '未配置 DEEPSEEK_API_KEY，只做了结构检查',
    }
  }
  if (!digest) return { ok: false, why: '没有可审核的歌词摘要' }

  const picked = songs.slice(0, MAX_AI_IDS).map((s) => ({
    name: s.name,
    artist: (s.artists || []).join(' / '),
    album: s.album || '',
  }))

  // 提示词尽量短：要求只回一行 JSON，并且 why 限 20 字
  const system =
    '你是歌词审核员。判断歌词是否属于给定歌曲。只输出一行 JSON：' +
    '{"ok":1或0,"why":"不超过20字的中文理由"}，不要任何其它文字。'

  const user = JSON.stringify({
    songs: picked,
    lyric: {
      lines: digest.lineCount,
      seconds: digest.durationSec,
      head: digest.head,
      tail: digest.tail,
    },
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + key,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // 只需要一行 JSON，给多了纯浪费
        max_tokens: 120,
        temperature: 0,
        stream: false,
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      const t = await res.text()
      return { ok: false, why: `审核服务返回 ${res.status}：${t.slice(0, 80)}` }
    }
    const data = await res.json()
    const text = String(
      (data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '') || '',
    )
    const usage = data.usage || {}

    // 模型偶尔会包 ```json 或加说明，宽进
    const m = text.match(/\{[\s\S]*\}/)
    if (!m) {
      return {
        ok: false,
        why: '审核返回无法解析：' + text.slice(0, 60),
        tokens: usage.total_tokens,
      }
    }
    let verdict
    try {
      verdict = JSON.parse(m[0])
    } catch {
      return {
        ok: false,
        why: '审核返回不是合法 JSON',
        tokens: usage.total_tokens,
      }
    }
    const ok = verdict.ok === 1 || verdict.ok === true || verdict.ok === '1'
    return {
      ok,
      why: String(verdict.why || '').slice(0, 60),
      tokens: usage.total_tokens,
      model: data.model || 'deepseek-chat',
    }
  } catch (e) {
    const msg =
      e && e.name === 'AbortError' ? '审核超时' : e.message || String(e)
    return { ok: false, why: msg }
  } finally {
    clearTimeout(timer)
  }
}

module.exports = {
  MAX_TTML_BYTES,
  MAX_AI_IDS,
  MIN_LINES,
  parse,
  structuralCheck,
  aiCheck,
}
